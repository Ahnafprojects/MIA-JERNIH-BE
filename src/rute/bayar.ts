/**
 * Modul pembayaran, tagihan, dan mode lunas-seketika.
 * Sesuai spesifikasi Issue #5.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import pkg, { type Transaksi } from "@prisma/client";
const { JenisTransaksi, StatusToken, StatusTransaksi, SumberToken } = pkg;
type StatusTransaksi = (typeof StatusTransaksi)[keyof typeof StatusTransaksi];
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { wajibMasuk } from "../middleware/sesi.js";
import { env } from "../env.js";
import { generateKodeToken, formatKodeMasked } from "./token.js";
import { hashKode } from "../lib/auth.js";
import { enkripsiKode, kodeBisaDisimpan } from "../lib/kode-token.js";
import { emailPembelianLunas, kirimEmail } from "../lib/email.js";

export const bayarRouter: Router = Router();
export const paketRouter: Router = Router();
export const pembayaranRouter: Router = Router();
export const transaksiRouter: Router = Router();
export const isiOtomatisRouter: Router = Router();

/* ── Fungsi Inti Pelunasan Bersama (Dipakai oleh Auto-Settle & Webhook) ── */

export async function selesaikanPembayaran(transaksiId: string): Promise<{
  transaksi: Transaksi;
  kodeToken?: string;
}> {
  const transaksi = await prisma.transaksi.findUnique({
    where: { id: transaksiId },
    include: {
      pengguna: true,
      meter: true,
      token: true,
    },
  });

  if (!transaksi) {
    throw notFound(`Transaksi #${transaksiId} tidak ditemukan.`);
  }

  // Idempoten: Jika sudah LUNAS, jangan pernah terbitkan token kedua!
  if (transaksi.status === StatusTransaksi.LUNAS) {
    return { transaksi };
  }

  const kode = generateKodeToken(10);
  const kodeAwalan = kode.slice(0, 5);
  const kodeHash = hashKode(kode);
  const expiredToken = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const [transaksiUpdate] = await prisma.$transaction([
    prisma.transaksi.update({
      where: { id: transaksi.id },
      data: {
        status: StatusTransaksi.LUNAS,
        dibayarPada: new Date(),
      },
    }),
    prisma.token.create({
      data: {
        kodeHash,
        kodeAwalan,
        /* Satu-satunya saat kode utuh pernah ada. Disimpan terenkripsi
           supaya pemiliknya bisa membukanya lagi sampai token dipakai.
           Tanpa ini, token hasil ISI OTOMATIS — yang tidak pernah melewati
           peramban siapa pun — cuma hidup di email, dan hilang permanen
           kalau emailnya gagal terkirim, padahal saldo sudah terpotong. */
        kodeTersandi: kodeBisaDisimpan() ? enkripsiKode(kode) : null,
        nilaiL: transaksi.volumeL,
        status: StatusToken.AKTIF,
        sumber: SumberToken.PEMBELIAN,
        meterId: transaksi.meterId,
        pemilikId: transaksi.penggunaId,
        transaksiId: transaksi.id,
        kedaluwarsaPada: expiredToken,
      },
    }),
    prisma.auditLog.create({
      data: {
        aktorId: transaksi.penggunaId,
        aktorNama: transaksi.pengguna.nama,
        aksi: "PEMBAYARAN_LUNAS",
        detail: `Pelunasan transaksi ${transaksi.id} sebesar Rp ${transaksi.jumlahRp.toString()} (${transaksi.volumeL.toString()} L). Token diterbitkan.`,
        tipe: "PEMBAYARAN",
      },
    }),
  ]);

  // Kirim email struk pembelian dengan kode token lengkap (sekali saja)
  await kirimEmail(
    emailPembelianLunas(transaksi.pengguna.email, {
      invoiceId: transaksi.id,
      meterId: transaksi.meterId,
      volumeL: Number(transaksi.volumeL),
      jumlahRp: Number(transaksi.jumlahRp),
      kodeToken: kode,
      metode: transaksi.metode,
      waktu: new Date().toISOString(),
    }),
  );

  return { transaksi: transaksiUpdate, kodeToken: kode };
}

/* ── 1. GET /api/paket ───────────────────────────────────────────────── */

paketRouter.get("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pengguna = await prisma.pengguna.findUnique({
      where: { id: req.pengguna!.id },
      include: { golongan: true },
    });

    const tarifPerLiter = pengguna?.golongan
      ? Number(pengguna.golongan.tarifPerLiter)
      : 7.5; // Tarif standar default: Rp 7.5 / Liter

    const paketLiter = [500, 1000, 2000, 5000, 10000];

    const daftarPaket = paketLiter.map((liter) => ({
      volumeL: liter,
      hargaRp: Math.round(liter * tarifPerLiter),
      label: `${(liter / 1000).toLocaleString("id-ID")} m³ (${liter.toLocaleString("id-ID")} Liter)`,
    }));

    res.status(200).json({
      golongan: pengguna?.golongan?.nama ?? "Rumah Tangga Umum",
      tarifPerLiter,
      minimalLiter: 500,
      maksimalLiter: MAKS_LITER_SEKALI_BELI,
      paket: daftarPaket,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Batas satu kali pembelian, dalam liter.
 *
 * Sebelumnya hanya ada batas bawah. Tanpa batas atas, warga bisa mengetik
 * berapa pun digit dan menghasilkan tagihan seperti
 * "Rp 15.000.000.000.000.000.000.000" — angkanya jebol keluar kartu dan
 * transaksinya tetap diterima server.
 *
 * 100.000 liter = 100 m³, sekitar tiga kali pemakaian bulanan rumah tangga
 * besar. Cukup longgar untuk pemakaian wajar, cukup ketat untuk menolak
 * ketikan yang jelas keliru.
 */
const MAKS_LITER_SEKALI_BELI = 100_000;

/* ── 2. POST /api/pembayaran ─────────────────────────────────────────── */

const skemaBeli = z.object({
  meterId: z.string().trim().min(1, "ID meter wajib diisi."),
  liter: z
    .number()
    .int("Volume pembelian harus bilangan bulat liter.")
    .min(500, "Pembelian minimal 500 liter.")
    .max(
      MAKS_LITER_SEKALI_BELI,
      `Pembelian maksimal ${MAKS_LITER_SEKALI_BELI.toLocaleString("id-ID")} liter sekali transaksi.`,
    ),
  metode: z.enum(["QRIS", "VA", "EWALLET", "GERAI"]).default("QRIS"),
});

pembayaranRouter.post("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId, liter, metode } = skemaBeli.parse(req.body);
    const penggunaId = req.pengguna!.id;

    const meter = await prisma.meter.findUnique({
      where: { id: meterId },
    });

    if (!meter) {
      throw notFound(`Meter ${meterId} tidak ditemukan.`);
    }

    if (req.pengguna!.peran === "WARGA" && meter.penggunaId !== penggunaId) {
      throw forbidden("Anda bukan pemilik meter ini.", "BUKAN_PEMILIK_METER");
    }

    const pengguna = await prisma.pengguna.findUnique({
      where: { id: penggunaId },
      include: { golongan: true },
    });

    const tarifPerLiter = pengguna?.golongan
      ? Number(pengguna.golongan.tarifPerLiter)
      : 7.5;

    const jumlahRp = Math.round(liter * tarifPerLiter);
    const invoiceId = `INV-${Date.now().toString().slice(-8)}`;

    const transaksiBaru = await prisma.transaksi.create({
      data: {
        id: invoiceId,
        penggunaId,
        meterId,
        jenis: JenisTransaksi.BELI,
        volumeL: liter,
        jumlahRp,
        metode,
        status: StatusTransaksi.MENUNGGU,
        qrString: metode === "QRIS" ? `00020101021226580014ID.CO.JERNIH0118${invoiceId}520458125303360540` : null,
        nomorVa: metode === "VA" ? `8808${Date.now().toString().slice(-10)}` : null,
        kedaluwarsaPada: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 jam
      },
    });

    // Cek Mode Peragaan PAYMENT_AUTO_SETTLE
    if (env().PAYMENT_AUTO_SETTLE) {
      const { transaksi: lunasTx, kodeToken } = await selesaikanPembayaran(transaksiBaru.id);

      res.status(200).json({
        invoiceId: lunasTx.id,
        jumlahRp: Number(lunasTx.jumlahRp),
        status: "LUNAS",
        volumeL: Number(lunasTx.volumeL),
        kode: kodeToken,
        meterId: lunasTx.meterId,
        qrString: null,
        vaNumber: null,
      });
      return;
    }

    res.status(200).json({
      invoiceId: transaksiBaru.id,
      jumlahRp: Number(transaksiBaru.jumlahRp),
      status: "MENUNGGU",
      volumeL: Number(transaksiBaru.volumeL),
      meterId: transaksiBaru.meterId,
      qrString: transaksiBaru.qrString,
      vaNumber: transaksiBaru.nomorVa,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/pembayaran/:invoice ─────────────────────────────────── */

pembayaranRouter.get(
  "/:invoice",
  wajibMasuk,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = req.params.invoice as string;
      if (!invoice) throw notFound("Invoice tidak valid.");

      const tx = await prisma.transaksi.findUnique({
        where: { id: invoice },
        include: {
          token: { select: { id: true, kodeAwalan: true, status: true } },
        },
      });

      if (!tx) {
        throw notFound("Tagihan tidak ditemukan.");
      }

      if (req.pengguna!.peran === "WARGA" && tx.penggunaId !== req.pengguna!.id) {
        throw forbidden("Akses ditolak.", "BUKAN_PEMILIK_TAGIHAN");
      }

      res.status(200).json({
        invoiceId: tx.id,
        meterId: tx.meterId,
        volumeL: Number(tx.volumeL),
        jumlahRp: Number(tx.jumlahRp),
        metode: tx.metode,
        status: tx.status,
        qrString: tx.qrString,
        nomorVa: tx.nomorVa,
        dibayarPada: tx.dibayarPada?.toISOString() ?? null,
        dibuatPada: tx.dibuatPada.toISOString(),
        /* Supaya halaman invoice bisa meminta kode utuhnya lewat
           `GET /api/token/:id/kode` saat tautan ini dibuka dari email atau
           dari perangkat selain tab pembeliannya. */
        tokenId: tx.token[0]?.id ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 4. POST /api/pembayaran/webhook ─────────────────────────────────── */

pembayaranRouter.post("/webhook", async (req: Request, res: Response, next: NextFunction) => {
  try {
    /*
     * TANDA TANGAN WAJIB, TANPA PENGECUALIAN.
     *
     * Versi sebelumnya membungkus pemeriksaan ini dalam
     * `if (rawSignature && ...)`, sehingga penyerang cukup TIDAK mengirim
     * header `X-Webhook-Signature` untuk melewatinya seluruhnya. Terbukti:
     * satu permintaan tanpa autentikasi melunasi tagihan Rp 37.500 (5.000 L)
     * dan menerbitkan token airnya.
     *
     * Sekarang: tidak ada rahasia -> tolak; tidak ada header -> tolak;
     * tanda tangan tidak cocok -> tolak. Gagal menutup, bukan membuka.
     */
    const webhookSecret = env().PAYMENT_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw badRequest(
        "WEBHOOK_BELUM_DIKONFIGURASI",
        "PAYMENT_WEBHOOK_SECRET belum disetel; webhook pembayaran dinonaktifkan.",
      );
    }

    const rawSignature = req.headers["x-webhook-signature"];
    if (typeof rawSignature !== "string" || rawSignature.length === 0) {
      throw badRequest(
        "SIGNATURE_WAJIB",
        "Header X-Webhook-Signature wajib disertakan.",
      );
    }

    const expected = createHmac("sha256", webhookSecret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    // `Buffer.from(x, "hex")` diam-diam memotong karakter non-hex, jadi panjang
    // yang kebetulan sama tidak cukup untuk dipercaya — cocokkan bentuknya dulu.
    const bentukHexSah = /^[0-9a-f]{64}$/i.test(rawSignature);
    const bufA = Buffer.from(rawSignature, "hex");
    const bufB = Buffer.from(expected, "hex");

    if (!bentukHexSah || bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      throw badRequest("SIGNATURE_INVALID", "Tanda tangan webhook tidak cocok.");
    }

    const { invoiceId, status } = req.body as { invoiceId?: string; status?: string };

    if (!invoiceId) {
      throw badRequest("INVOICE_WAJIB", "Parameter invoiceId wajib disertakan.");
    }

    if (status === "PAID" || status === "LUNAS" || status === "SETTLED") {
      await selesaikanPembayaran(invoiceId);
    }

    res.status(200).json({ ok: true, pesan: "Webhook berhasil diproses" });
  } catch (err) {
    next(err);
  }
});

/* ── 5. GET /api/transaksi?filter=&page= ──────────────────────────────── */

transaksiRouter.get("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const penggunaId = req.pengguna!.id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.max(1, Math.min(50, Number(req.query.perPage) || 15));
    const filter = req.query.filter as string | undefined;

    const where: { penggunaId: string; status?: StatusTransaksi } = { penggunaId };
    if (filter) {
      where.status = filter.toUpperCase() as StatusTransaksi;
    }

    const [total, rows] = await Promise.all([
      prisma.transaksi.count({ where }),
      prisma.transaksi.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { dibuatPada: "desc" },
        include: {
          token: {
            select: { id: true, kodeAwalan: true, status: true },
          },
        },
      }),
    ]);

    res.status(200).json({
      rows: rows.map((r) => ({
        id: r.id,
        meterId: r.meterId,
        jenis: r.jenis,
        volumeL: Number(r.volumeL),
        jumlahRp: Number(r.jumlahRp),
        metode: r.metode,
        status: r.status,
        token: r.token[0] ? formatKodeMasked(r.token[0].kodeAwalan) : null,
        /*
         * `tokenId` dan `tokenStatus` ikut dikirim supaya halaman riwayat
         * bisa meminta kode utuhnya lewat `GET /api/token/:id/kode`.
         *
         * Tanpa keduanya, satu-satunya jalan dari invoice ke token adalah
         * menebak lewat lima digit awalan — dan lima digit bisa dimiliki dua
         * token berbeda. Statusnya dikirim juga supaya UI bisa membedakan
         * "kodenya masih ada" dari "tokennya sudah dipakai" tanpa permintaan
         * tambahan yang sudah pasti ditolak.
         */
        tokenId: r.token[0]?.id ?? null,
        tokenStatus: r.token[0]?.status ?? null,
        dibuatPada: r.dibuatPada.toISOString(),
        dibayarPada: r.dibayarPada?.toISOString() ?? null,
      })),
      total,
      page,
      perPage,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 6. GET /api/transaksi/:id ───────────────────────────────────────── */

transaksiRouter.get("/:id", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw notFound("ID transaksi tidak valid.");

    const tx = await prisma.transaksi.findUnique({
      where: { id },
      include: {
        meter: true,
        pengguna: { select: { nama: true, email: true } },
        token: true,
      },
    });

    if (!tx) {
      throw notFound("Transaksi tidak ditemukan.");
    }

    if (req.pengguna!.peran === "WARGA" && tx.penggunaId !== req.pengguna!.id) {
      throw forbidden("Akses ditolak.", "BUKAN_PEMILIK_TRANSAKSI");
    }

    const struk = {
      invoiceId: tx.id,
      namaPelanggan: tx.pengguna.nama,
      idMeter: tx.meterId,
      volumeL: Number(tx.volumeL),
      jumlahRp: Number(tx.jumlahRp),
      metode: tx.metode,
      status: tx.status,
      kodeTokenBertopeng: tx.token[0] ? formatKodeMasked(tx.token[0].kodeAwalan) : null,
      dibuatPada: tx.dibuatPada.toISOString(),
      dibayarPada: tx.dibayarPada?.toISOString() ?? null,
    };

    res.status(200).json({
      transaksi: tx,
      struk,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 7. Pengaturan isi otomatis ──────────────────────────────────────── */

/*
 * Diletakkan di modul pembayaran, bukan modul meter, karena yang diatur di
 * sini adalah PEMBELIAN — ambang hanyalah pemicunya. Pelaksanaannya ada di
 * `lib/isi-otomatis.ts`.
 */

const skemaIsiOtomatis = z.object({
  meterId: z.string().trim().min(1, "ID meter wajib diisi."),
  aktif: z.boolean(),
  /*
   * Ambang dibatasi 10–50.000 L. Batas bawahnya BUKAN kerapian: di bawah
   * 10 L warga sudah masuk wilayah alarm firmware (≤5 L), dan pembelian
   * yang terbit di sana tidak akan pernah sempat ditukarkan sebelum relay
   * menutup — fiturnya menyala tapi tidak menyelamatkan apa pun.
   */
  ambangL: z.number().int().min(10).max(50_000).optional(),
  volumeL: z
    .number()
    .int()
    .min(500, "Paket isi otomatis minimal 500 liter.")
    .max(MAKS_LITER_SEKALI_BELI)
    .optional(),
  metode: z.enum(["QRIS", "VA", "EWALLET", "GERAI"]).optional(),
});

isiOtomatisRouter.get("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meterId = (req.query.meterId as string | undefined)?.trim();
    if (!meterId) throw badRequest("METER_WAJIB", "Parameter meterId wajib diisi.");

    const meter = await prisma.meter.findUnique({ where: { id: meterId } });
    if (!meter) throw notFound(`Meter ${meterId} tidak ditemukan.`);

    if (req.pengguna!.peran === "WARGA" && meter.penggunaId !== req.pengguna!.id) {
      throw forbidden("Anda bukan pemilik meter ini.", "BUKAN_PEMILIK_METER");
    }

    res.status(200).json({
      meterId: meter.id,
      aktif: meter.isiOtomatisAktif,
      ambangL: meter.isiOtomatisAmbangL,
      volumeL: meter.isiOtomatisVolumeL,
      metode: meter.isiOtomatisMetode,
      terakhirPada: meter.isiOtomatisTerakhir?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
});

isiOtomatisRouter.put("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId, aktif, ambangL, volumeL, metode } =
      skemaIsiOtomatis.parse(req.body);

    const meter = await prisma.meter.findUnique({ where: { id: meterId } });
    if (!meter) throw notFound(`Meter ${meterId} tidak ditemukan.`);

    if (req.pengguna!.peran === "WARGA" && meter.penggunaId !== req.pengguna!.id) {
      throw forbidden("Anda bukan pemilik meter ini.", "BUKAN_PEMILIK_METER");
    }

    const diperbarui = await prisma.meter.update({
      where: { id: meter.id },
      data: {
        isiOtomatisAktif: aktif,
        ...(ambangL !== undefined ? { isiOtomatisAmbangL: ambangL } : {}),
        ...(volumeL !== undefined ? { isiOtomatisVolumeL: volumeL } : {}),
        ...(metode !== undefined ? { isiOtomatisMetode: metode } : {}),
        /*
         * Menyalakan ulang fitur MENGHAPUS jeda. Warga yang baru saja
         * menyalakannya mengharapkan pembelian terjadi sekarang bila
         * saldonya memang sudah di bawah ambang — bukan menunggu enam jam
         * karena ada pembelian otomatis kemarin.
         */
        ...(aktif && !meter.isiOtomatisAktif ? { isiOtomatisTerakhir: null } : {}),
      },
    });

    res.status(200).json({
      meterId: diperbarui.id,
      aktif: diperbarui.isiOtomatisAktif,
      ambangL: diperbarui.isiOtomatisAmbangL,
      volumeL: diperbarui.isiOtomatisVolumeL,
      metode: diperbarui.isiOtomatisMetode,
      terakhirPada: diperbarui.isiOtomatisTerakhir?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
});
