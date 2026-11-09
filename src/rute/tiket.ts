/**
 * Modul pengaduan warga (tiket) dan perhitungan SLA.
 * Sesuai spesifikasi Issue #6.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import pkg from "@prisma/client";
const { StatusTiket } = pkg;
type StatusTiket = (typeof StatusTiket)[keyof typeof StatusTiket];
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";
import { emailTiketDiperbarui, kirimEmail } from "../lib/email.js";
import { kabariWarga } from "../lib/notifikasi.js";
import { kunciTiket, pesanTiketDiperbarui } from "../lib/pesan-notifikasi.js";
import { env } from "../env.js";
import {
  JENDELA_GANDA_JAM,
  bacaGpsExif,
  cariDugaanGanda,
  koordinatMasukAkal,
  nilaiKeyakinanLokasi,
  type SumberLokasi,
  type Titik,
} from "../lib/validasi-laporan.js";

export const tiketRouter: Router = Router();
export const adminTiketRouter: Router = Router();

/* ── Standar Jam SLA per Kategori ────────────────────────────────────── */

export const JAM_SLA_KATEGORI: Record<string, number> = {
  "kebocoran pipa": 6,
  "air tidak mengalir": 12,
  "air keruh/berbau": 24,
  "tekanan lemah": 24,
  "meter/keypad rusak": 48,
  lainnya: 72,
};

export function hitungSlaJatuhTempo(kategori: string, tanggalDibuat: Date): Date {
  const kunci = kategori.toLowerCase();
  const jamSla = JAM_SLA_KATEGORI[kunci] ?? 48;
  return new Date(tanggalDibuat.getTime() + jamSla * 60 * 60 * 1000);
}

/**
 * Nomor urut tiket berikutnya untuk bulan berjalan.
 *
 * Versi sebelumnya membaca tiket terakhir lalu menambah satu di memori. Itu
 * balapan klasik: delapan pengaduan yang tiba bersamaan menghasilkan SATU
 * nomor yang sama (sudah diuji), dan karena `Tiket.nomor` ber-`@unique`,
 * tujuh di antaranya gagal dengan 500 — tepat pada saat gangguan besar,
 * ketika banyak warga melapor serentak.
 *
 * `padStart(4)` juga dipertahankan hanya sebagai lebar minimum. Dulu lebarnya
 * mengikat: tiket ke-10.000 menghasilkan "…-10000", yang pada urutan STRING
 * jatuh di bawah "…-9999", sehingga penomoran berputar balik dan bertabrakan.
 * Di sini urutan dihitung dari JUMLAH baris, bukan dari urutan string.
 */
async function nomorBerikutnya(awalan: string): Promise<string> {
  const jumlah = await prisma.tiket.count({ where: { nomor: { startsWith: awalan } } });
  return `${awalan}${String(jumlah + 1).padStart(4, "0")}`;
}

export async function buatNomorTiket(): Promise<string> {
  const d = new Date();
  const thn = d.getFullYear();
  const bln = String(d.getMonth() + 1).padStart(2, "0");
  return nomorBerikutnya(`LP-${thn}-${bln}-`);
}

/**
 * Membuat tiket sambil menangani tabrakan nomor.
 *
 * Keunikan ditegakkan basis data, bukan oleh pembacaan di atas: kalau dua
 * permintaan tetap memilih nomor yang sama, yang kalah mendapat P2002 dan
 * mencoba lagi dengan nomor berikutnya. Itu sebabnya nomor TIDAK boleh
 * dihitung sekali di luar lalu dipakai berulang.
 */
export async function buatTiketDenganNomor<T>(
  buat: (nomor: string) => Promise<T>,
  maksCoba = 8,
): Promise<T> {
  const d = new Date();
  const awalan = `LP-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-`;

  let urut = (await prisma.tiket.count({ where: { nomor: { startsWith: awalan } } })) + 1;
  for (let coba = 0; coba < maksCoba; coba++) {
    try {
      return await buat(`${awalan}${String(urut).padStart(4, "0")}`);
    } catch (err) {
      const kode = (err as { code?: string }).code;
      const target = (err as { meta?: { target?: string[] } }).meta?.target;
      const bentrokNomor =
        kode === "P2002" && (!target || target.includes("nomor"));
      if (!bentrokNomor) throw err;
      urut++;
    }
  }
  throw new Error(
    `Gagal memperoleh nomor tiket unik setelah ${maksCoba} percobaan.`,
  );
}

/* ── Validasi Zod ────────────────────────────────────────────────────── */

const skemaFoto = z
  .string()
  .trim()
  .refine(
    (uri) =>
      uri.startsWith("data:image/") ||
      /^https?:\/\//i.test(uri) ||
      uri.startsWith("/"),
    "Foto harus berupa data URI gambar valid atau URL HTTP/HTTPS.",
  );

const skemaBuatTiket = z.object({
  kategori: z.string().trim().min(3, "Kategori pengaduan wajib dipilih."),
  deskripsi: z.string().trim().min(5, "Deskripsi pengaduan minimal 5 karakter."),
  foto: z.array(skemaFoto).max(3, "Maksimal 3 foto pendukung.").default([]),
  lat: z.number().optional(),
  lng: z.number().optional(),
  meterId: z.string().trim().optional(),
  /*
   * Dari mana koordinatnya berasal. Dikirim klien karena hanya klien yang
   * tahu: GPS perangkat, penanda yang digeser sendiri, atau tidak keduanya.
   *
   * Nilainya TIDAK dipercaya begitu saja — ia cuma satu masukan bagi
   * `nilaiKeyakinanLokasi`, yang juga menimbang jarak ke meter terdaftar dan
   * GPS pada foto. Klien yang mengaku "GPS_PERANGKAT" sambil mengirim titik
   * 50 km dari meternya tetap turun ke keyakinan rendah.
   */
  sumberLokasi: z
    .enum(["GPS_PERANGKAT", "DIPILIH_MANUAL", "METER_TERDAFTAR", "TIDAK_ADA"])
    .optional(),
});

const skemaUbahTiketAdmin = z.object({
  status: z.enum(["BARU", "DIPROSES", "SELESAI"]),
  teknisiId: z.string().trim().optional(),
  catatan: z.string().trim().optional(),
});

tiketRouter.use(wajibMasuk);
adminTiketRouter.use(wajibMasuk);

/*
 * Pembatas laju KHUSUS pembuatan tiket, di atas pembatas global.
 *
 * Ambangnya sengaja longgar: enam laporan per sepuluh menit per alamat IP.
 * Saat pipa induk pecah, satu keluarga bisa melapor dari beberapa perangkat
 * di jaringan rumah yang sama, dan satu RT bisa berbagi satu IP seluler.
 * Ambang ketat akan membungkam laporan yang justru paling mendesak.
 *
 * Ini satu-satunya hal di seluruh alur validasi yang benar-benar MENOLAK.
 * Selebihnya hanya menandai.
 */
const limiterBuatTiket = rateLimit({
  windowMs: 10 * 60_000,
  limit: 6,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      error: {
        code: "TERLALU_BANYAK_LAPORAN",
        message:
          "Terlalu banyak laporan dikirim dari jaringan ini dalam waktu singkat. Tunggu beberapa menit, lalu coba lagi. Laporan yang sudah masuk tetap diproses.",
      },
    }),
});

/* ── 1. POST /api/tiket ──────────────────────────────────────────────── */

tiketRouter.post(
  "/",
  limiterBuatTiket,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = skemaBuatTiket.parse(req.body);
      const pelaporId = req.pengguna!.id;

      // Validasi foto (maks 3 foto, masing-masing <= 5MB bila base64)
      for (const f of data.foto) {
        if (f.startsWith("data:") && f.length > 7_000_000) {
          throw badRequest("FOTO_TERLALU_BESAR", "Ukuran foto maksimal 5 MB per berkas.");
        }
      }

      /*
       * Koordinat diselesaikan DI SERVER, bukan dipercayakan ke klien.
       *
       * Versi sebelumnya menerima apa pun yang dikirim klien, dan klien
       * mengirim satu titik yang ditulis mati untuk setiap laporan. Akibatnya
       * seluruh tiket di basis data menunjuk koordinat yang sama persis,
       * sementara antarmukanya menuliskan "Lokasi Terdeteksi di Sekitar Meter
       * Anda". Petanya nanti akan menumpuk setiap pengaduan di satu titik.
       *
       * Sekarang: kalau klien tidak mengirim titik yang masuk akal, server
       * memakai koordinat meter terdaftar milik pelapor DAN menurunkan
       * sumbernya menjadi `METER_TERDAFTAR`, sehingga keyakinannya ikut
       * turun. Cadangan yang jujur, bukan cadangan yang menyamar.
       */
      const meterPelapor = await prisma.meter.findFirst({
        where: data.meterId
          ? { id: data.meterId, penggunaId: pelaporId }
          : { penggunaId: pelaporId },
        select: { id: true, lat: true, lng: true, serial: true },
      });

      const titikMeter: Titik | null =
        meterPelapor?.lat != null && meterPelapor?.lng != null
          ? { lat: meterPelapor.lat, lng: meterPelapor.lng }
          : null;

      const titikKlien: Titik | null =
        data.lat != null && data.lng != null ? { lat: data.lat, lng: data.lng } : null;

      let titik: Titik | null = null;
      let sumber: SumberLokasi = "TIDAK_ADA";

      if (titikKlien && koordinatMasukAkal(titikKlien)) {
        titik = titikKlien;
        sumber = data.sumberLokasi ?? "DIPILIH_MANUAL";
        // Klien boleh menyebut sumbernya, tetapi tidak boleh mengaku
        // "METER_TERDAFTAR" untuk titik yang bukan koordinat meternya.
        if (sumber === "METER_TERDAFTAR" && titikMeter) {
          const sama =
            Math.abs(titik.lat - titikMeter.lat) < 1e-6 &&
            Math.abs(titik.lng - titikMeter.lng) < 1e-6;
          if (!sama) sumber = "DIPILIH_MANUAL";
        }
      } else if (titikMeter) {
        titik = titikMeter;
        sumber = "METER_TERDAFTAR";
      }

      // GPS dari foto, bila ada. Mayoritas foto sah tidak membawanya.
      const gpsFoto: Titik[] = [];
      for (const f of data.foto) {
        const g = bacaGpsExif(f);
        if (g) gpsFoto.push(g);
      }

      const keyakinan = nilaiKeyakinanLokasi({
        titik,
        sumber,
        titikMeter,
        gpsFoto,
      });

      // Aduan serupa dalam jendela waktu, untuk digabungkan petugas.
      const sejak = new Date(Date.now() - JENDELA_GANDA_JAM * 60 * 60 * 1000);
      const kandidat = await prisma.tiket.findMany({
        where: { dibuatPada: { gte: sejak }, status: { not: StatusTiket.SELESAI } },
        select: {
          id: true,
          nomor: true,
          kategori: true,
          lat: true,
          lng: true,
          dibuatPada: true,
          pelaporId: true,
        },
        take: 200,
      });
      const ganda = cariDugaanGanda({ kategori: data.kategori, titik, pelaporId }, kandidat);

      const dibuatPada = new Date();
      const slaJatuhTempo = hitungSlaJatuhTempo(data.kategori, dibuatPada);

      const tiket = await buatTiketDenganNomor((nomor) =>
        prisma.tiket.create({
          data: {
            nomor,
            pelaporId,
            kategori: data.kategori,
            deskripsi: data.deskripsi,
            fotoUrl: data.foto,
            lat: titik?.lat ?? null,
            lng: titik?.lng ?? null,
            meterId: meterPelapor?.id ?? null,
            status: StatusTiket.BARU,
            slaJatuhTempo,
            dibuatPada,
          },
        }),
      );

      /*
       * Hasil validasi dicatat ke AuditLog, bukan ke kolom baru di `Tiket`.
       *
       * Alasannya bukan kerapian: menambah kolom menuntut migrasi basis data
       * produksi, dan berkas skema dipegang orang lain. AuditLog memang
       * dirancang untuk jejak semacam ini, sudah dibaca halaman audit konsol,
       * dan tidak menuntut perubahan bentuk tabel apa pun.
       *
       * Konsekuensinya jujur: penilaian ini TIDAK bisa dipakai memfilter atau
       * mengurutkan tiket lewat kueri basis data. Kalau nanti dibutuhkan,
       * barulah kolomnya pantas ditambahkan.
       */
      await prisma.auditLog.create({
        data: {
          aktorId: pelaporId,
          aktorNama: req.pengguna!.id,
          aksi: `TIKET_VALIDASI_${keyakinan.keyakinan}`,
          detail: [
            `Tiket ${tiket.nomor}: keyakinan lokasi ${keyakinan.keyakinan} (sumber ${keyakinan.sumber}).`,
            ...keyakinan.catatan,
            ganda.alasan ? `Dugaan ganda: ${ganda.alasan}` : null,
          ]
            .filter(Boolean)
            .join(" "),
          tipe: "TIKET",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      res.status(201).json({
        ok: true,
        tiket: {
          id: tiket.id,
          nomor: tiket.nomor,
          kategori: tiket.kategori,
          deskripsi: tiket.deskripsi,
          status: tiket.status,
          slaJatuhTempo: tiket.slaJatuhTempo.toISOString(),
          dibuatPada: tiket.dibuatPada.toISOString(),
        },
        validasi: {
          keyakinanLokasi: keyakinan.keyakinan,
          sumberLokasi: keyakinan.sumber,
          catatan: keyakinan.catatan,
          jarakKeMeterM: keyakinan.jarakKeMeterM,
          jarakKeFotoM: keyakinan.jarakKeFotoM,
          fotoBerGps: gpsFoto.length,
          jumlahFoto: data.foto.length,
          terikatMeter: meterPelapor?.serial ?? null,
          dugaanGanda: ganda.adaDugaan,
          catatanGanda: ganda.alasan,
          nomorSerupa: ganda.nomorSerupa,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 1b. GET /api/tiket/lokasi-awal ──────────────────────────────────── */

/*
 * Titik awal untuk peta pemilih lokasi.
 *
 * WAJIB terdaftar SEBELUM `GET /:id` di bawah. Express mencocokkan rute
 * berurutan, jadi `/:id` yang didaftarkan lebih dulu akan menelan
 * "lokasi-awal" sebagai sebuah id dan membalas 404 — gejala yang terlihat
 * seperti endpoint yang tidak pernah terpasang.
 */
tiketRouter.get(
  "/lokasi-awal",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const meter = await prisma.meter.findFirst({
        where: { penggunaId: req.pengguna!.id },
        select: { serial: true, lat: true, lng: true, zona: { select: { nama: true } } },
      });

      res.status(200).json({
        // `null` bila meternya memang belum berkoordinat. Klien menampilkan
        // peta tanpa penanda, bukan penanda di titik karangan.
        lat: meter?.lat ?? null,
        lng: meter?.lng ?? null,
        serialMeter: meter?.serial ?? null,
        zona: meter?.zona?.nama ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 2. GET /api/tiket ───────────────────────────────────────────────── */

tiketRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pelaporId = req.pengguna!.id;

    const daftarTiket = await prisma.tiket.findMany({
      where: { pelaporId },
      orderBy: { dibuatPada: "desc" },
      include: {
        meter: { select: { id: true, serial: true } },
      },
    });

    const sekarang = Date.now();

    res.status(200).json({
      tiket: daftarTiket.map((t) => {
        const slaTerlampaui = t.selesaiPada
          ? t.selesaiPada.getTime() > t.slaJatuhTempo.getTime()
          : sekarang > t.slaJatuhTempo.getTime();

        return {
          id: t.id,
          nomor: t.nomor,
          kategori: t.kategori,
          deskripsi: t.deskripsi,
          status: t.status,
          meterId: t.meterId,
          slaJatuhTempo: t.slaJatuhTempo.toISOString(),
          slaTerlampaui,
          dibuatPada: t.dibuatPada.toISOString(),
          selesaiPada: t.selesaiPada?.toISOString() ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/tiket/:id ───────────────────────────────────────────── */

tiketRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw notFound("ID tiket tidak valid.");

    const tiket = await prisma.tiket.findFirst({
      where: {
        OR: [{ id }, { nomor: id }],
      },
      include: {
        meter: true,
        pelapor: { select: { id: true, nama: true, email: true } },
        teknisi: { select: { id: true, nama: true, hp: true } },
      },
    });

    if (!tiket) {
      throw notFound("Tiket pengaduan tidak ditemukan.");
    }

    if (req.pengguna!.peran === "WARGA" && tiket.pelaporId !== req.pengguna!.id) {
      throw forbidden("Anda tidak berhak melihat tiket pengaduan orang lain.");
    }

    const sekarang = Date.now();
    const slaTerlampaui = tiket.selesaiPada
      ? tiket.selesaiPada.getTime() > tiket.slaJatuhTempo.getTime()
      : sekarang > tiket.slaJatuhTempo.getTime();

    // Kronologi
    const kronologi: Array<{ waktu: string; judul: string }> = [
      {
        waktu: tiket.dibuatPada.toISOString(),
        judul: "Laporan pengaduan diterima sistem",
      },
    ];

    if (tiket.status === "DIPROSES" || tiket.status === "SELESAI") {
      kronologi.push({
        waktu: tiket.diubahPada.toISOString(),
        judul: `Ditugaskan kepada teknisi${tiket.teknisi ? ` (${tiket.teknisi.nama})` : ""}`,
      });
    }

    if (tiket.status === "SELESAI" && tiket.selesaiPada) {
      kronologi.push({
        waktu: tiket.selesaiPada.toISOString(),
        judul: "Pengaduan selesai ditangani dan diverifikasi",
      });
    }

    res.status(200).json({
      tiket: {
        id: tiket.id,
        nomor: tiket.nomor,
        kategori: tiket.kategori,
        deskripsi: tiket.deskripsi,
        fotoUrl: tiket.fotoUrl,
        lat: tiket.lat,
        lng: tiket.lng,
        status: tiket.status,
        meterId: tiket.meterId,
        slaJatuhTempo: tiket.slaJatuhTempo.toISOString(),
        slaTerlampaui,
        dibuatPada: tiket.dibuatPada.toISOString(),
        diubahPada: tiket.diubahPada.toISOString(),
        selesaiPada: tiket.selesaiPada?.toISOString() ?? null,
        kronologi,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4. GET /api/admin/tiket?status=&zona= ───────────────────────────── */

adminTiketRouter.get(
  "/",
  wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string | undefined;
      const zona = req.query.zona as string | undefined;

      const where: { status?: StatusTiket; meter?: { zonaId: string } } = {};
      if (status) where.status = status.toUpperCase() as StatusTiket;
      if (zona) where.meter = { zonaId: zona };

      const list = await prisma.tiket.findMany({
        where,
        orderBy: { dibuatPada: "desc" },
        include: {
          pelapor: { select: { nama: true, email: true, hp: true } },
          teknisi: { select: { nama: true } },
          meter: { select: { id: true, serial: true, zona: { select: { nama: true } } } },
        },
      });

      const sekarang = Date.now();

      res.status(200).json({
        tiket: list.map((t) => ({
          id: t.id,
          nomor: t.nomor,
          kategori: t.kategori,
          deskripsi: t.deskripsi,
          status: t.status,
          zona: t.meter?.zona?.nama ?? null,
          pelapor: t.pelapor,
          teknisi: t.teknisi?.nama ?? null,
          slaJatuhTempo: t.slaJatuhTempo.toISOString(),
          slaTerlampaui: t.selesaiPada
            ? t.selesaiPada.getTime() > t.slaJatuhTempo.getTime()
            : sekarang > t.slaJatuhTempo.getTime(),
          dibuatPada: t.dibuatPada.toISOString(),
          selesaiPada: t.selesaiPada?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 5. PATCH /api/admin/tiket/:id ───────────────────────────────────── */

adminTiketRouter.patch(
  "/:id",
  wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      if (!id) throw notFound("ID tiket tidak valid.");

      const { status, teknisiId, catatan } = skemaUbahTiketAdmin.parse(req.body);

      const tiket = await prisma.tiket.findUnique({
        where: { id },
        include: { pelapor: true },
      });

      if (!tiket) {
        throw notFound("Tiket tidak ditemukan.");
      }

      const statusLama = tiket.status;
      const statusBaru = status;
      const selesaiPada =
        statusBaru === StatusTiket.SELESAI ? new Date() : tiket.selesaiPada;

      /*
       * Waktu tanggap dicatat SEKALI, saat tiket keluar dari BARU.
       *
       * Sebelumnya "rata-rata waktu tanggap" di halaman publik dihitung dari
       * `diubahPada - dibuatPada`. `diubahPada` adalah `@updatedAt`: ia ikut
       * berubah setiap kali baris tiket disunting, termasuk saat ditutup
       * berhari-hari kemudian. Hasilnya angka yang terbaca sebagai 18.434
       * menit — 12,8 hari — dan disajikan ke publik sebagai waktu tanggap.
       *
       * `??` memastikan nilainya tidak pernah ditimpa oleh perubahan status
       * berikutnya: yang dicari adalah tanggapan PERTAMA.
       */
      const ditanggapiPada =
        tiket.ditanggapiPada ??
        (statusBaru !== StatusTiket.BARU ? new Date() : null);

      const updated = await prisma.tiket.update({
        where: { id },
        data: {
          status: statusBaru,
          teknisiId: teknisiId ?? tiket.teknisiId,
          ditanggapiPada,
          selesaiPada,
        },
      });

      // Catat ke AuditLog
      await prisma.auditLog.create({
        data: {
          aktorId: req.pengguna!.id,
          aktorNama: req.pengguna!.id,
          aksi: `TIKET_${statusBaru}`,
          detail: `Status tiket ${tiket.nomor} diubah dari ${statusLama} ke ${statusBaru}.${catatan ? ` Catatan: ${catatan}` : ""}`,
          tipe: "TIKET",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      // Kirim email notifikasi ke pelapor
      if (tiket.pelapor?.email) {
        await kirimEmail(
          emailTiketDiperbarui(
            tiket.pelapor.email,
            tiket.nomor,
            statusLama,
            statusBaru,
            catatan,
          ),
        );
      }

      /*
       * WhatsApp dan Telegram, ke saluran yang disetujui pelapor sendiri.
       *
       * TIDAK di-`await`, dan itu disengaja. Yang sedang menunggu balasan
       * permintaan ini adalah petugas yang baru mengubah status, dan
       * statusnya sudah tersimpan di atas. Menunggu pengiriman berarti
       * petugas menatap pemuatan selama soket WhatsApp menyambung ulang,
       * lalu melihat kegagalan untuk pekerjaan yang sebenarnya berhasil.
       *
       * `kabariWarga` sudah menelan galatnya sendiri dan tidak pernah
       * melempar, jadi `void` di sini tidak menyembunyikan apa pun yang
       * belum tercatat di log.
       *
       * Yang menentukan saluran mana yang dipakai adalah kolom `waOptIn`,
       * `waNomor`, dan `telegramChatId` milik pelapor. Ketiganya ikut
       * terbawa karena kuerinya memakai `include: { pelapor: true }`, yang
       * mengambil seluruh kolom skalar.
       */
      if (tiket.pelapor) {
        void kabariWarga(
          tiket.pelapor,
          kunciTiket(tiket.nomor, statusBaru),
          pesanTiketDiperbarui({
            nomorTiket: tiket.nomor,
            statusLama,
            statusBaru,
            catatan,
            appUrl: env().APP_URL,
          }),
        );
      }

      res.status(200).json({
        ok: true,
        tiket: updated,
      });
    } catch (err) {
      next(err);
    }
  },
);
