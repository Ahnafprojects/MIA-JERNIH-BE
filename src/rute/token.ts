/**
 * Modul token: aturan, generator, dan penukaran.
 * Sesuai spesifikasi Issue #4.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomInt } from "node:crypto";
import { z } from "zod";
import pkg from "@prisma/client";
const { StatusToken, SumberToken } = pkg;
type StatusToken = (typeof StatusToken)[keyof typeof StatusToken];
type SumberToken = (typeof SumberToken)[keyof typeof SumberToken];
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { dekripsiKode } from "../lib/kode-token.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";
import { hashKode } from "../lib/auth.js";
import { lcdUtama } from "./meter.js";
import { env } from "../env.js";
import { wsManager } from "../ws.js";

export const tokenRouter: Router = Router();
export const adminTokenRouter: Router = Router();

/* ── Pelacak Percobaan Salah Token per Pengguna (5x salah -> jeda 10m) ── */

interface CatatanGagalToken {
  gagal: number;
  terkunciSampai: number;
}

const mapGagalPengguna = new Map<string, CatatanGagalToken>();

function bersihkanCatatanKedaluwarsa() {
  if (mapGagalPengguna.size > 50) {
    const sekarang = Date.now();
    for (const [id, c] of mapGagalPengguna.entries()) {
      if (sekarang > c.terkunciSampai && c.terkunciSampai > 0) {
        mapGagalPengguna.delete(id);
      }
    }
  }
}

function cekKunciPengguna(penggunaId: string) {
  bersihkanCatatanKedaluwarsa();
  const catatan = mapGagalPengguna.get(penggunaId);
  if (!catatan) return;

  if (Date.now() < catatan.terkunciSampai) {
    const sisaMenit = Math.ceil((catatan.terkunciSampai - Date.now()) / 60000);
    throw badRequest(
      "PERCOBAAN_TERKUNCI",
      `Terlalu banyak percobaan penukaran token yang salah. Percobaan dijeda selama ${sisaMenit} menit.`,
    );
  } else if (catatan.terkunciSampai > 0) {
    // Kunci sudah berakhir, reset
    mapGagalPengguna.delete(penggunaId);
  }
}

function catatGagal(penggunaId: string) {
  bersihkanCatatanKedaluwarsa();
  const catatan = mapGagalPengguna.get(penggunaId) ?? {
    gagal: 0,
    terkunciSampai: 0,
  };
  catatan.gagal += 1;
  if (catatan.gagal >= 5) {
    catatan.terkunciSampai = Date.now() + 10 * 60 * 1000; // 10 menit
  }
  mapGagalPengguna.set(penggunaId, catatan);
}

function resetGagal(penggunaId: string) {
  mapGagalPengguna.delete(penggunaId);
}

/* ── Generator Kode Token CSPRNG ─────────────────────────────────────── */

export function generateKodeToken(panjang = 10): string {
  let hasil = "";
  for (let i = 0; i < panjang; i++) {
    hasil += String(randomInt(0, 10));
  }
  return hasil;
}

export function formatKodeMasked(kodeAwalan: string): string {
  return `${kodeAwalan} •••••`;
}

/* ── Skema Validasi ──────────────────────────────────────────────────── */

const skemaTukar = z.object({
  kode: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, "Kode token hanya boleh berupa angka 4 hingga 10 digit."),
  meterId: z.string().trim().min(1, "ID meter wajib diisi."),
});

const skemaBuatTokenAdmin = z.object({
  meterId: z.string().trim().optional(),
  nilaiL: z.number().positive("Nilai liter harus lebih dari 0."),
  jumlah: z.number().int().min(1).max(100).default(1),
  alasan: z.string().trim().min(3, "Alasan penerbitan token wajib diisi."),
});

/* ── 1. POST /api/token/tukar ────────────────────────────────────────── */

tokenRouter.post("/tukar", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { kode, meterId } = skemaTukar.parse(req.body);
    const penggunaId = req.pengguna!.id;

    // 1. Dukungan Token Demo Firmware: 1111 (+5 L) dan 2222 (+10 L)
    // Tidak memakai kuota percobaan salah
    if (kode === "1111" || kode === "2222") {
      if (!env().DEMO_TOKEN_ENABLED) {
        throw badRequest("TOKEN_INVALID", "Kode token tidak valid.");
      }

      const tambahL = kode === "1111" ? 5 : 10;
      const meter = await prisma.meter.findUnique({
        where: { id: meterId },
      });

      if (!meter) throw notFound(`Meter ${meterId} tidak ditemukan.`);

      if (req.pengguna!.peran === "WARGA" && meter.penggunaId !== penggunaId) {
        throw forbidden("Anda bukan pemilik meter ini.", "BUKAN_PEMILIK_METER");
      }

      const saldoBaru = Number(meter.saldoL) + tambahL;
      await prisma.$transaction([
        prisma.meter.update({
          where: { id: meterId },
          data: { saldoL: saldoBaru },
        }),
        prisma.auditLog.create({
          data: {
            aktorId: penggunaId,
            aktorNama: req.pengguna!.id,
            aksi: "TOKEN_DEMO_DITUKAR",
            detail: `Penukaran token demo ${kode} senilai ${tambahL} L pada meter ${meterId}. Saldo baru: ${saldoBaru} L`,
            tipe: "TOKEN",
            ip: req.ip ?? "127.0.0.1",
          },
        }),
      ]);

      resetGagal(penggunaId);

      wsManager.kirimKeRoom(`meter:${meterId}`, "meter:saldo", {
        meterId,
        saldoBaruL: saldoBaru,
        tambahL,
      });

      const lcd = lcdUtama({
        saldoL: saldoBaru,
        saklarOn: meter.saklarOn,
        debitLpm: Number(meter.debitLpm),
        volumeTotalL: Number(meter.volumeTotalL),
      });

      res.status(200).json({
        status: "BERHASIL",
        nilaiL: tambahL,
        saldoBaruL: saldoBaru,
        lcd,
      });
      return;
    }

    // 2. Periksa apakah pengguna sedang terkunci (lockout)
    cekKunciPengguna(penggunaId);

    const meter = await prisma.meter.findUnique({
      where: { id: meterId },
    });

    if (!meter) throw notFound(`Meter ${meterId} tidak ditemukan.`);

    if (req.pengguna!.peran === "WARGA" && meter.penggunaId !== penggunaId) {
      throw forbidden("Anda bukan pemilik meter ini.", "BUKAN_PEMILIK_METER");
    }

    const kodeHash = hashKode(kode);
    const token = await prisma.token.findUnique({
      where: { kodeHash },
    });

    if (!token) {
      catatGagal(penggunaId);
      throw badRequest("TOKEN_INVALID", "Kode token tidak valid.");
    }

    // Token terikat ke satu meter
    if (token.meterId && token.meterId !== meterId) {
      catatGagal(penggunaId);
      throw badRequest(
        "METER_TIDAK_COCOK",
        `Token ini diterbitkan khusus untuk meter lain (${token.meterId}).`,
      );
    }

    // Token sudah pernah dipakai
    if (token.status === StatusToken.TERPAKAI || token.dipakaiPada) {
      const tgl = (token.dipakaiPada ?? new Date()).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      catatGagal(penggunaId);
      throw badRequest(
        "TOKEN_SUDAH_DIPAKAI",
        `Token sudah dipakai pada ${tgl}.`,
      );
    }

    // Token kedaluwarsa (lewat 30 hari)
    if (token.status === StatusToken.KEDALUWARSA || token.kedaluwarsaPada.getTime() < Date.now()) {
      catatGagal(penggunaId);
      throw badRequest("TOKEN_KEDALUWARSA", "Masa berlaku token telah kedaluwarsa.");
    }

    // Token dibatalkan
    if (token.status === StatusToken.DIBATALKAN) {
      catatGagal(penggunaId);
      throw badRequest("TOKEN_DIBATALKAN", "Token ini telah dibatalkan oleh petugas.");
    }

    const nilaiL = Number(token.nilaiL);
    const saldoBaru = Number(meter.saldoL) + nilaiL;

    // Transaksi penukaran sukses
    await prisma.$transaction([
      prisma.token.update({
        where: { id: token.id },
        data: {
          status: StatusToken.TERPAKAI,
          dipakaiPada: new Date(),
          dipakaiMeterId: meterId,
          /* Kode terenkripsi DIBUANG di transaksi yang sama dengan
             penukarannya. Kode yang sudah terpakai tidak bisa dipakai lagi,
             jadi menyimpannya cuma memperpanjang umur risiko tanpa satu pun
             manfaat. Dikosongkan di sini, bukan lewat pembersih terjadwal,
             supaya tidak pernah ada jendela waktu antara "sudah dipakai" dan
             "kodenya hilang". */
          kodeTersandi: null,
        },
      }),
      prisma.meter.update({
        where: { id: meterId },
        data: { saldoL: saldoBaru },
      }),
      prisma.auditLog.create({
        data: {
          aktorId: penggunaId,
          aktorNama: req.pengguna!.id,
          aksi: "TOKEN_DITUKAR",
          detail: `Penukaran token senilai ${nilaiL} L pada meter ${meterId}. Saldo baru: ${saldoBaru} L`,
          tipe: "TOKEN",
          ip: req.ip ?? "127.0.0.1",
        },
      }),
    ]);

    resetGagal(penggunaId);

    wsManager.kirimKeRoom(`meter:${meterId}`, "meter:saldo", {
      meterId,
      saldoBaruL: saldoBaru,
      tambahL: nilaiL,
    });

    const lcd = lcdUtama({
      saldoL: saldoBaru,
      saklarOn: meter.saklarOn,
      debitLpm: Number(meter.debitLpm),
      volumeTotalL: Number(meter.volumeTotalL),
    });

    res.status(200).json({
      status: "BERHASIL",
      nilaiL,
      saldoBaruL: saldoBaru,
      lcd,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2a. GET /api/token/:id/kode ──────────────────────────────────────
 *
 * Mengembalikan kode token UTUH kepada pemiliknya, selama token belum
 * dipakai. Inilah yang membuat kode token berperilaku seperti kode pada
 * struk token listrik: bisa dibuka lagi besok, dari perangkat mana pun,
 * sampai ia benar-benar ditukarkan.
 *
 * Tiga syarat, semuanya harus terpenuhi:
 *   1. Pemanggilnya pemilik token itu — bukan sekadar sudah masuk.
 *   2. Statusnya masih AKTIF.
 *   3. Belum lewat masa berlakunya.
 *
 * Yang gagal syarat 1 dijawab 404, BUKAN 403. Membedakan "bukan milik Anda"
 * dari "tidak ada" memberi tahu penyerang bahwa id yang ditebaknya benar —
 * dan id token adalah cuid yang muncul di jawaban API lain.
 *
 * Pengambilannya dicatat di audit log. Kode yang bisa dibuka ulang menuntut
 * jejak siapa yang membukanya; tanpa itu, penyalahgunaan sesi yang dicuri
 * tidak meninggalkan bekas apa pun.
 */
tokenRouter.get(
  "/:id/kode",
  wajibMasuk,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const penggunaId = req.pengguna!.id;
      const tokenId = String(req.params.id ?? "");

      const token = await prisma.token.findFirst({
        where: { id: tokenId, pemilikId: penggunaId },
        select: {
          id: true,
          status: true,
          kodeAwalan: true,
          kodeTersandi: true,
          kedaluwarsaPada: true,
          nilaiL: true,
          meterId: true,
        },
      });

      if (!token) {
        throw notFound("Token tidak ditemukan.");
      }

      /*
       * Token yang sudah dipakai atau kedaluwarsa dijawab 200 dengan
       * `kode: null` dan alasannya — bukan galat.
       *
       * Ini BUKAN kegagalan permintaan: pertanyaannya ("apa kodenya?")
       * terjawab dengan benar, jawabannya memang "tidak ada lagi". Dijawab
       * sebagai galat, halaman riwayat harus menebak sendiri bedanya
       * gangguan jaringan dari token yang memang sudah terpakai, dan tebakan
       * itu akan salah pada saat yang paling membingungkan warga.
       */
      const kedaluwarsa = token.kedaluwarsaPada.getTime() <= Date.now();
      if (token.status !== StatusToken.AKTIF || kedaluwarsa) {
        res.status(200).json({
          id: token.id,
          kode: null,
          kodeBertopeng: formatKodeMasked(token.kodeAwalan),
          status: kedaluwarsa && token.status === StatusToken.AKTIF
            ? StatusToken.KEDALUWARSA
            : token.status,
          alasan: "TOKEN_TIDAK_AKTIF",
        });
        return;
      }

      const kode = dekripsiKode(token.kodeTersandi);

      if (!kode) {
        /*
         * Token terbit SEBELUM kolom `kodeTersandi` ada, atau kuncinya
         * diputar tanpa migrasi data. Keduanya tidak bisa dipulihkan —
         * kode aslinya memang tidak pernah tersimpan di mana pun.
         *
         * Dikatakan terus terang dengan kode alasan sendiri supaya UI bisa
         * mengarahkan warga ke email struknya, alih-alih menampilkan
         * bintang-bintang tanpa penjelasan.
         */
        res.status(200).json({
          id: token.id,
          kode: null,
          kodeBertopeng: formatKodeMasked(token.kodeAwalan),
          status: token.status,
          alasan: "KODE_TIDAK_TERSIMPAN",
        });
        return;
      }

      await prisma.auditLog.create({
        data: {
          aktorId: penggunaId,
          aktorNama: req.pengguna!.id,
          aksi: "LIHAT_KODE_TOKEN",
          detail: `Membuka kode token ${token.id} senilai ${Number(token.nilaiL)} L untuk meter ${token.meterId ?? "-"}.`,
          tipe: "TOKEN",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      res.status(200).json({
        id: token.id,
        kode,
        kodeBertopeng: formatKodeMasked(token.kodeAwalan),
        status: token.status,
        kedaluwarsaPada: token.kedaluwarsaPada.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 2. GET /api/token/belum-dipakai ─────────────────────────────────── */

tokenRouter.get(
  "/belum-dipakai",
  wajibMasuk,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const penggunaId = req.pengguna!.id;

      const tokens = await prisma.token.findMany({
        where: {
          pemilikId: penggunaId,
          status: StatusToken.AKTIF,
          kedaluwarsaPada: { gt: new Date() },
        },
        orderBy: { dibuatPada: "desc" },
      });

      res.status(200).json({
        tokens: tokens.map((t) => ({
          id: t.id,
          kodeBertopeng: formatKodeMasked(t.kodeAwalan),
          nilaiL: Number(t.nilaiL),
          meterId: t.meterId,
          kedaluwarsaPada: t.kedaluwarsaPada.toISOString(),
          dibuatPada: t.dibuatPada.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 3. POST /api/admin/token (Generator Petugas) ────────────────────── */

adminTokenRouter.post(
  "/",
  wajibMasuk,
  wajibPeran("OPERATOR", "SUPERVISOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = skemaBuatTokenAdmin.parse(req.body);
      const penggunaId = req.pengguna!.id;

      const kedaluwarsaPada = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 hari

      const tokenDibuat: Array<{ id: string; kode: string; nilaiL: number }> = [];

      for (let i = 0; i < data.jumlah; i++) {
        const kode = generateKodeToken(10);
        const kodeAwalan = kode.slice(0, 5);
        const kodeHash = hashKode(kode);

        const rec = await prisma.token.create({
          data: {
            kodeHash,
            kodeAwalan,
            nilaiL: data.nilaiL,
            status: StatusToken.AKTIF,
            sumber: SumberToken.ADMIN,
            meterId: data.meterId ?? null,
            pembuatId: penggunaId,
            kedaluwarsaPada,
          },
        });

        tokenDibuat.push({
          id: rec.id,
          kode,
          nilaiL: data.nilaiL,
        });
      }

      await prisma.auditLog.create({
        data: {
          aktorId: penggunaId,
          aktorNama: req.pengguna!.id,
          aksi: "BUAT_TOKEN_ADMIN",
          detail: `Menerbitkan ${data.jumlah} token senilai ${data.nilaiL} L. Alasan: ${data.alasan}`,
          tipe: "ADMIN",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      res.status(201).json({
        ok: true,
        total: tokenDibuat.length,
        tokens: tokenDibuat,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 4. GET /api/admin/token?status=&page= ───────────────────────────── */

adminTokenRouter.get(
  "/",
  wajibMasuk,
  wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(req.query.perPage) || 20));
      const statusQuery = req.query.status as string | undefined;

      const whereClause = statusQuery
        ? { status: statusQuery.toUpperCase() as StatusToken }
        : {};

      const [total, rows, aktifCount, usedCount, expiredCount, revokedCount, aktifSum] =
        await Promise.all([
          prisma.token.count({ where: whereClause }),
          prisma.token.findMany({
            where: whereClause,
            skip: (page - 1) * perPage,
            take: perPage,
            orderBy: { dibuatPada: "desc" },
            include: {
              meter: { select: { id: true, serial: true } },
              pemilik: { select: { id: true, nama: true, email: true } },
            },
          }),
          prisma.token.count({ where: { status: StatusToken.AKTIF } }),
          prisma.token.count({ where: { status: StatusToken.TERPAKAI } }),
          prisma.token.count({ where: { status: StatusToken.KEDALUWARSA } }),
          prisma.token.count({ where: { status: StatusToken.DIBATALKAN } }),
          prisma.token.aggregate({
            where: { status: StatusToken.AKTIF },
            _sum: { nilaiL: true },
          }),
        ]);

      const kpi = [
        { key: "aktif", label: "Token Aktif", value: aktifCount },
        { key: "used", label: "Token Terpakai", value: usedCount },
        { key: "expired", label: "Kedaluwarsa", value: expiredCount },
        { key: "revoked", label: "Dibatalkan", value: revokedCount },
        {
          key: "literBelumDipakai",
          label: "Liter Belum Ditukar",
          value: Number(aktifSum._sum.nilaiL ?? 0),
          unit: "L",
        },
      ];

      res.status(200).json({
        kpi,
        rows: rows.map((r) => ({
          id: r.id,
          kodeBertopeng: formatKodeMasked(r.kodeAwalan),
          nilaiL: Number(r.nilaiL),
          status: r.status,
          sumber: r.sumber,
          meterId: r.meterId,
          pemilik: r.pemilik ? { nama: r.pemilik.nama, email: r.pemilik.email } : null,
          dipakaiPada: r.dipakaiPada?.toISOString() ?? null,
          kedaluwarsaPada: r.kedaluwarsaPada.toISOString(),
          dibuatPada: r.dibuatPada.toISOString(),
        })),
        total,
        page,
        perPage,
      });
    } catch (err) {
      next(err);
    }
  },
);
