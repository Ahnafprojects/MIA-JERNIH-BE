/**
 * Endpoint publik — transparansi tanpa login.
 * Sesuai spesifikasi Issue #2.
 *
 * PENTING:
 * - Tidak ada data pribadi (PII): nama, email, hp, alamat, ID meter, koordinat rumah.
 * - kpi selalu array [{ key, label, value, ... }].
 * - Jawaban lacak tiket anonim dan aman.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { JAM_SLA_KATEGORI } from "./tiket.js";
import {
  deretHarian,
  neracaAir,
  perZonaNeraca,
  rentangSah,
  ringkasNeraca,
} from "../lib/neraca.js";
import {
  SET_TERSEDIA,
  buatKumpulan,
  keCsv,
  keJson,
  namaBerkas,
} from "../lib/unduh.js";

export const publikRouter: Router = Router();

const limiterPublik = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      error: {
        code: "RATE_LIMIT",
        message: "Terlalu banyak permintaan pada endpoint publik. Coba lagi sebentar.",
      },
    }),
});

publikRouter.use(limiterPublik);

/* ── 1. GET /api/publik/status-layanan ────────────────────────────────── */

/**
 * Cincin luar sebuah GeoJSON Polygon, atau `null` kalau bentuknya bukan itu.
 *
 * `batasGeo` bertipe `Json` di skema, jadi isinya tidak dijamin apa pun —
 * baris lama, hasil impor yang salah, atau `null` semuanya mungkin. Yang
 * dikembalikan hanya cincin yang benar-benar berupa senarai pasangan angka;
 * selain itu `null`, supaya peta memperlakukannya sebagai zona tanpa batas
 * alih-alih melempar di tengah render.
 */
function cincinLuar(geo: unknown): [number, number][] | null {
  if (!geo || typeof geo !== "object") return null;
  const g = geo as { type?: unknown; coordinates?: unknown };
  if (g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;

  // `unknown[]`, bukan `any[]`: `coordinates` datang dari kolom Json, jadi
  // tiap lapisnya harus diperiksa sendiri — bukan dipercaya bentuknya.
  const cincin: unknown = (g.coordinates as unknown[])[0];
  if (!Array.isArray(cincin) || cincin.length < 4) return null;

  const titik: [number, number][] = [];
  for (const t of cincin as unknown[]) {
    if (
      !Array.isArray(t) ||
      typeof t[0] !== "number" ||
      typeof t[1] !== "number"
    ) {
      return null;
    }
    titik.push([t[0], t[1]]);
  }
  return titik;
}

publikRouter.get("/status-layanan", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const semuaZona = await prisma.zona.findMany({
      include: {
        meter: {
          select: { id: true, penggunaId: true },
        },
      },
      orderBy: { nama: "asc" },
    });

    const insidenTerbuka = await prisma.insiden.findMany({
      where: { status: { in: ["BARU", "DITUGASKAN"] } },
      include: {
        meter: {
          select: { zonaId: true },
        },
      },
      orderBy: { dibukaPada: "desc" },
    });

    let normalCount = 0;
    let gangguanCount = 0;
    let perbaikanCount = 0;

    const zonaList = semuaZona.map((z) => {
      const insidenZona = insidenTerbuka.filter(
        (i) => i.meter?.zonaId === z.id,
      );

      let statusZona: "normal" | "gangguan" | "perbaikan" = "normal";
      let keterangan = "Layanan normal beroperasi";
      let sejak: string | undefined;
      let perkiraanPulih: string | undefined;
      let pelangganTerdampak = 0;

      const insidenUtama = insidenZona[0];
      if (insidenUtama) {
        sejak = insidenUtama.dibukaPada.toISOString();
        keterangan =
          insidenZona.length > 1
            ? `${insidenUtama.judul} (+${insidenZona.length - 1} laporan lain)`
            : insidenUtama.judul;

        /*
         * `perkiraanPulih` dihilangkan, bukan ditebak.
         *
         * Sebelumnya selalu "dibuka + 4 jam" untuk insiden apa pun — pipa
         * induk pecah dan keran bocor mendapat janji yang sama. Perkiraan
         * yang meleset di portal publik lebih merugikan daripada tidak ada
         * perkiraan: warga menunggu berdasarkan angka yang tidak pernah
         * punya dasar. Kalau nanti operator bisa mengisinya, ambil dari
         * kolom di tabel Insiden, bukan dari konstanta di sini.
         */
        perkiraanPulih = undefined;

        if (insidenUtama.status === "DITUGASKAN") {
          statusZona = "perbaikan";
          perbaikanCount++;
        } else {
          statusZona = "gangguan";
          gangguanCount++;
        }

        /*
         * Hanya meter yang benar-benar punya insiden terbuka. Sebelumnya
         * SELURUH pelanggan di zona dihitung terdampak, sehingga satu
         * keluhan tunggal terbaca sebagai gangguan sekawasan.
         */
        const meterTerdampak = new Set(
          insidenZona.map((i) => i.meterId).filter((id): id is string => !!id),
        );
        pelangganTerdampak = z.meter.filter(
          (m) => m.penggunaId !== null && meterTerdampak.has(m.id),
        ).length;
      } else {
        normalCount++;
      }

      return {
        id: z.id,
        nama: z.nama,
        status: statusZona,
        pelangganTerdampak,
        sejak,
        perkiraanPulih,
        keterangan,
        /*
         * `batas` — cincin luar polygon, bentuk yang DIBACA frontend.
         *
         * Endpoint ini hanya mengirim `batasGeo` (objek GeoJSON mentah),
         * sedangkan peta di /status membaca `zona.batas` sebagai senarai
         * titik. Akibatnya `z.batas` selalu `undefined`, penjaganya
         * (`batas !== null`) meloloskannya, dan `batas.length` melempar
         * TypeError yang menjatuhkan seluruh komponen peta. Yang tampil di
         * layar: "Peramban ini tidak mendukung WebGL" — pesan yang keliru
         * pada peramban yang WebGL-nya baik-baik saja.
         *
         * `batasGeo` tetap dikirim supaya pemakai lama tidak rusak.
         */
        batas: cincinLuar(z.batasGeo),
        batasGeo: z.batasGeo ?? null,
      };
    });

    res.status(200).json({
      zona: zonaList,
      ringkas: {
        normal: normalCount,
        gangguan: gangguanCount,
        perbaikan: perbaikanCount,
      },
      ts: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. GET /api/publik/lacak/:nomor ─────────────────────────────────── */

/**
 * Pelacakan pengaduan warga tanpa autentikasi.
 *
 * Keputusan desain: Endpoint ini sengaja dibuat terbuka demi transparansi
 * publik dan kemudahan warga melacak status aduan air mereka tanpa hambatan
 * login. Perlindungan privasi (PII) dijamin di tingkat respon: seluruh data
 * pribadi pelapor (nama, email, nomor HP, foto dokumen, koordinat rumah)
 * dibersihkan secara total — yang disajikan hanya status tahapan, kategori,
 * dan estimasi kepatuhan SLA.
 */
publikRouter.get("/lacak/:nomor", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nomor = req.params.nomor as string;
    if (!nomor) {
      throw notFound("Nomor tiket tidak valid.");
    }

    const tiket = await prisma.tiket.findUnique({
      where: { nomor },
      include: {
        meter: {
          include: { zona: true },
        },
      },
    });

    if (!tiket) {
      throw notFound(
        `Tiket pengaduan #${nomor} tidak ditemukan. Periksa kembali nomor pengaduan Anda.`,
      );
    }

    const sekarang = Date.now();
    const jatuhTempo = tiket.slaJatuhTempo.getTime();
    const selesaiPadaMs = tiket.selesaiPada?.getTime();

    const slaTerlampaui = selesaiPadaMs
      ? selesaiPadaMs > jatuhTempo
      : sekarang > jatuhTempo;

    const kronologi: Array<{ waktu: string; judul: string }> = [
      {
        waktu: tiket.dibuatPada.toISOString(),
        judul: "Laporan diterima oleh sistem",
      },
    ];

    if (tiket.status === "DIPROSES" || tiket.status === "SELESAI") {
      kronologi.push({
        waktu: tiket.diubahPada.toISOString(),
        judul: "Ditugaskan ke teknisi",
      });
    }

    if (tiket.status === "SELESAI" && tiket.selesaiPada) {
      kronologi.push({
        waktu: tiket.selesaiPada.toISOString(),
        judul: "Pengaduan selesai ditangani",
      });
    }

    res.status(200).json({
      nomor: tiket.nomor,
      kategori: tiket.kategori,
      status: tiket.status,
      zona: tiket.meter?.zona?.nama ?? "Wilayah Pusat",
      dibuatPada: tiket.dibuatPada.toISOString(),
      slaJatuhTempo: tiket.slaJatuhTempo.toISOString(),
      slaTerlampaui,
      kronologi,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/publik/kinerja?rentang=30 ───────────────────────────── */

publikRouter.get("/kinerja", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rentangHari = Math.max(1, Math.min(365, Number(req.query.rentang) || 30));
    const batasWaktu = new Date(Date.now() - rentangHari * 24 * 60 * 60 * 1000);

    const tiketList = await prisma.tiket.findMany({
      where: { dibuatPada: { gte: batasWaktu } },
    });

    const tiketMasuk = tiketList.length;
    const tiketSelesai = tiketList.filter((t) => t.status === "SELESAI").length;

    const tiketTepatWaktu = tiketList.filter((t) => {
      if (t.status !== "SELESAI" || !t.selesaiPada) return false;
      return t.selesaiPada <= t.slaJatuhTempo;
    }).length;

    const ketepatanSlaPct =
      tiketSelesai > 0
        ? Number(((tiketTepatWaktu / tiketSelesai) * 100).toFixed(1))
        : undefined;

    /*
     * Waktu tanggap dari `ditanggapiPada`, BUKAN `diubahPada`.
     *
     * `diubahPada` adalah `@updatedAt` — ikut berubah tiap kali baris tiket
     * disunting, termasuk saat ditutup berhari-hari kemudian. Dengan data
     * seed, rumus lama menghasilkan 18.434 menit (12,8 hari) dan menyajikannya
     * ke publik sebagai "rata-rata waktu tanggap".
     *
     * Tiket yang belum punya `ditanggapiPada` (mis. data lama sebelum kolom
     * ini ada) dilewati, bukan ditaksir — lebih baik rata-rata dari sedikit
     * tiket yang benar daripada banyak tiket yang salah.
     */
    let totalMenitTanggap = 0;
    let jumlahTiketTanggap = 0;
    for (const t of tiketList) {
      if (!t.ditanggapiPada) continue;
      const menit = Math.round(
        (t.ditanggapiPada.getTime() - t.dibuatPada.getTime()) / 60000,
      );
      if (menit >= 0) {
        totalMenitTanggap += menit;
        jumlahTiketTanggap++;
      }
    }

    const rataTanggapMenit =
      jumlahTiketTanggap > 0
        ? Math.round(totalMenitTanggap / jumlahTiketTanggap)
        : undefined;

    const kpi: Array<{
      key: string;
      label: string;
      value?: number;
      unit?: string;
      tone?: "neutral" | "positive" | "warning";
    }> = [
      { key: "tiketMasuk", label: "Pengaduan masuk", value: tiketMasuk },
      { key: "tiketSelesai", label: "Selesai", value: tiketSelesai },
    ];

    if (ketepatanSlaPct !== undefined) {
      kpi.push({
        key: "ketepatanSlaPct",
        label: "Tepat waktu",
        value: ketepatanSlaPct,
        unit: "%",
        tone: ketepatanSlaPct >= 90 ? "positive" : "warning",
      });
    }

    if (rataTanggapMenit !== undefined) {
      kpi.push({
        key: "rataTanggapMenit",
        label: "Rata-rata waktu tanggap",
        value: rataTanggapMenit,
        unit: "menit",
      });
    }

    const perKategoriMap = new Map<string, { masuk: number; selesai: number; tepat: number }>();
    for (const t of tiketList) {
      const kat = perKategoriMap.get(t.kategori) ?? { masuk: 0, selesai: 0, tepat: 0 };
      kat.masuk++;
      if (t.status === "SELESAI") {
        kat.selesai++;
        if (t.selesaiPada && t.selesaiPada <= t.slaJatuhTempo) {
          kat.tepat++;
        }
      }
      perKategoriMap.set(t.kategori, kat);
    }

    const perKategori = Array.from(perKategoriMap.entries()).map(([kategori, val]) => ({
      kategori,
      masuk: val.masuk,
      selesai: val.selesai,
      ketepatanPct:
        val.selesai > 0
          ? Number(((val.tepat / val.selesai) * 100).toFixed(1))
          : undefined,
    }));

    /*
     * TREN DIHITUNG DARI TIKET SUNGGUHAN, BUKAN DIKARANG.
     *
     * Versi sebelumnya membuat empat titik dari satu angka dengan offset
     * tetap (-4, -2, +1, 0) lalu menyajikannya sebagai "Ketepatan SLA" per
     * pekan. Itu grafik yang isinya tidak pernah terjadi. Di portal yang
     * seluruh gagasannya transparansi, angka karangan adalah cacat yang
     * paling mahal — bukan sekadar tidak rapi.
     *
     * Pekan dihitung mundur dari sekarang. Pekan tanpa tiket selesai
     * bernilai `null`, bukan ditambal angka: "belum ada data" dan "100%"
     * adalah dua pernyataan yang sangat berbeda.
     */
    const MS_PEKAN = 7 * 24 * 60 * 60 * 1000;
    const jumlahPekan = Math.min(8, Math.max(1, Math.ceil(rentangHari / 7)));
    const labels: string[] = [];
    const points: Array<number | null> = [];

    for (let p = jumlahPekan - 1; p >= 0; p--) {
      const akhir = new Date(Date.now() - p * MS_PEKAN);
      const mulai = new Date(akhir.getTime() - MS_PEKAN);
      const selesaiPekan = tiketList.filter(
        (t) =>
          t.status === "SELESAI" &&
          t.selesaiPada &&
          t.selesaiPada > mulai &&
          t.selesaiPada <= akhir,
      );
      const tepat = selesaiPekan.filter(
        (t) => t.selesaiPada && t.selesaiPada <= t.slaJatuhTempo,
      ).length;

      labels.push(p === 0 ? "Pekan ini" : `${p} pekan lalu`);
      points.push(
        selesaiPekan.length > 0
          ? Number(((tepat / selesaiPekan.length) * 100).toFixed(1))
          : null,
      );
    }

    res.status(200).json({
      periode: {
        mulai: batasWaktu.toISOString(),
        selesai: new Date().toISOString(),
        hari: rentangHari,
      },
      kpi,
      perKategori,
      tren: {
        labels,
        series: [
          {
            name: "Ketepatan SLA",
            unit: "%",
            points,
          },
        ],
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4. GET /api/publik/statistik?rentang=30 ─────────────────────────── */

publikRouter.get("/statistik", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rentangHari = Math.max(1, Math.min(365, Number(req.query.rentang) || 30));

    const [totalMeter, totalPelanggan, totalZona, riwayatVolume] = await Promise.all([
      prisma.meter.count(),
      prisma.pengguna.count({ where: { peran: "WARGA" } }),
      prisma.zona.count(),
      prisma.meter.aggregate({
        _sum: { volumeTotalL: true },
      }),
    ]);

    /*
     * Volume SEUMUR HIDUP meter, bukan volume rentang ini.
     *
     * Tetap dikirim di dalam `agregat` karena pemakai lama membacanya, tetapi
     * TIDAK lagi dipakai sebagai `volumeTercatatM3` di tingkat atas: ubin di
     * halaman depan berlabel "Air tercatat 30 hari terakhir", dan mengisinya
     * dengan total sejak meter dipasang membuat labelnya berbohong.
     */
    const volumeSeumurHidupM3 = Number(
      ((riwayatVolume._sum.volumeTotalL?.toNumber() ?? 0) / 1000).toFixed(1),
    );

    /*
     * NRW kini DIHITUNG, bukan `null`.
     *
     * Sebelumnya nilainya dipatok `14.8`, lalu diganti `null` karena memang
     * belum ada angka air yang DIPRODUKSI di basis data mana pun — yang
     * tercatat hanya yang terpakai di meter pelanggan. `null` jujur, tetapi
     * akibatnya ubin "Kehilangan air" di halaman depan selamanya menampilkan
     * "—" pada portal yang menjual transparansi kehilangan air.
     *
     * Tabel `NeracaHarian` menutup lubang itu pada sumbernya: ia menyimpan
     * bacaan meter induk tiap zona berdampingan dengan yang tercatat di meter
     * pelanggan. Yang dilakukan di sini hanya menjumlah dan membagi.
     */
    const [ringkas, deret, perZonaBaris] = await Promise.all([
      ringkasNeraca(rentangHari),
      deretHarian(Math.min(rentangHari, 90)),
      perZonaNeraca(rentangHari),
    ]);

    const zonaList = await prisma.zona.findMany({
      include: {
        _count: {
          select: { meter: true, pengguna: true },
        },
      },
    });

    const distribusiZona = zonaList.map((z) => ({
      zonaId: z.id,
      nama: z.nama,
      totalMeter: z._count.meter,
      totalPelanggan: z._count.pengguna,
    }));

    const petaPelangganZona = new Map(
      zonaList.map((z) => [z.id, z._count.pengguna]),
    );

    /*
     * BENTUK DATAR DI TINGKAT ATAS — ini yang dibaca frontend.
     *
     * `src/types/publik.ts` (StatistikPublik) menuntut `pelangganTerlayani`,
     * `volumeTercatatM3`, `jumlahZona`, `labels`, `series`, dan `perZona` di
     * tingkat atas. Endpoint ini sebelumnya hanya mengirim `agregat` bersarang
     * dengan nama berbeda, sehingga SELURUH angka di pita statistik landing
     * page tampil sebagai "—" — hal pertama yang dilihat pengunjung.
     *
     * `agregat` dan `distribusiZona` tetap dikirim supaya pemakai lama tidak
     * rusak.
     *
     * Deretnya kini DUA: air disalurkan dan air tercatat. Satu deret saja
     * tidak bisa memperlihatkan kehilangan air, dan jarak antara kedua garis
     * itulah yang sebenarnya ingin dilihat orang di halaman ini.
     *
     * Sumbernya `NeracaHarian`, bukan `EmberPemakaian`. `EmberPemakaian`
     * hanya menyimpan 9 hari ke belakang, jadi grafik 30 hari yang disusun
     * darinya berisi 21 hari bernilai nol dan terbaca seolah jaringannya mati
     * tiga minggu.
     */
    const labels = deret.map((d) => d.tanggal);

    res.status(200).json({
      rentangHari,
      pelangganTerlayani: totalPelanggan,
      volumeDisalurkanM3: ringkas.disalurkanM3,
      volumeTercatatM3: ringkas.tercatatM3,
      nrwPct: ringkas.nrwPct,
      jumlahZona: totalZona,
      labels,
      series: [
        {
          name: "Air disalurkan",
          unit: "m³",
          points: deret.map((d) => d.disalurkanM3),
        },
        {
          name: "Air tercatat",
          unit: "m³",
          points: deret.map((d) => d.tercatatM3),
        },
      ],
      perZona: perZonaBaris.map((z) => ({
        nama: z.nama,
        pelanggan: petaPelangganZona.get(z.zonaId) ?? 0,
        volumeM3: z.tercatatM3,
        nrwPct: z.nrwPct,
      })),
      agregat: {
        totalMeter,
        totalPelanggan,
        totalZona,
        volumeTercatatM3: ringkas.tercatatM3,
        volumeSeumurHidupM3,
        nrwRataPct: ringkas.nrwPct,
      },
      distribusiZona,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4b. GET /api/publik/neraca-air?rentang=30 ───────────────────────── */

/*
 * Neraca air lengkap: ke mana perginya air yang tidak sampai ke meter.
 *
 * `/statistik` menjawab BERAPA yang hilang; endpoint ini menjawab KE MANA.
 * Keduanya dijumlahkan dari tabel yang sama (`NeracaHarian`) lewat
 * `src/lib/neraca.ts`, jadi angka besar di halaman depan dan rincian di
 * halaman statistik tidak mungkin berselisih.
 *
 * Rentangnya dibatasi 7/30/90 — bukan sembarang angka seperti `/statistik`.
 * Rincian neraca air berasal dari audit triwulanan; menyajikannya untuk
 * rentang 3 hari akan terbaca seolah komponennya diukur harian.
 */
publikRouter.get("/neraca-air", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hari = rentangSah(Number(req.query.rentang) || 30);
    res.status(200).json(await neracaAir(hari));
  } catch (err) {
    next(err);
  }
});

/* ── 4c. GET /api/publik/unduh?set=harian&format=csv&rentang=30 ──────── */

/*
 * Data mentah yang bisa diunduh, dalam CSV atau JSON.
 *
 * Janji "data terbuka" di halaman statistik tidak berarti apa-apa kalau
 * tombol unduhnya 404. Isinya dibangkitkan dari fungsi yang sama dengan yang
 * menyuapi halaman — lihat `src/lib/unduh.ts` untuk alasan kenapa itu tidak
 * boleh ditawar.
 */
publikRouter.get("/unduh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    /*
     * Hanya nilai yang BENAR-BENAR string yang diterima.
     *
     * Express mem-parsing `?set[x]=y` menjadi objek dan `?set=a&set=b`
     * menjadi array. `String()` pada keduanya menghasilkan "[object Object]"
     * dan "a,b" — yang lalu muncul utuh di dalam pesan galat yang dikirim
     * balik ke peramban. Bentuk yang bukan string diperlakukan sebagai tidak
     * diisi, lalu jatuh ke nilai bawaan.
     */
    const teks = (v: unknown, bawaan: string): string =>
      typeof v === "string" ? v : bawaan;

    const set = teks(req.query.set, "harian");
    const format = teks(req.query.format, "csv").toLowerCase();
    const hari = rentangSah(Number(req.query.rentang) || 30);

    if (format !== "csv" && format !== "json") {
      res.status(400).json({
        error: {
          code: "FORMAT_TIDAK_DIDUKUNG",
          message: `Format "${format}" tidak didukung. Pilihan yang tersedia: csv, json.`,
        },
      });
      return;
    }

    const kumpulan = await buatKumpulan(set, hari);
    if (!kumpulan) {
      res.status(400).json({
        error: {
          code: "SET_TIDAK_DIKENAL",
          message: `Kumpulan data "${set}" tidak ada. Pilihan yang tersedia: ${SET_TERSEDIA.join(", ")}.`,
        },
      });
      return;
    }

    // `attachment` yang membuat tombol di halaman benar-benar mengunduh
    // berkas, bukan membuka JSON mentah di tab baru.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${namaBerkas(kumpulan, hari, format)}"`,
    );

    if (format === "json") {
      res.status(200).json(keJson(kumpulan, hari));
      return;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(keCsv(kumpulan));
  } catch (err) {
    next(err);
  }
});

/* ── 5. GET /api/publik/peta ─────────────────────────────────────────── */

publikRouter.get("/peta", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const zonaList = await prisma.zona.findMany();
    const insidenTerbuka = await prisma.insiden.findMany({
      where: { status: { in: ["BARU", "DITUGASKAN"] } },
      include: {
        // `lat`/`lng` sengaja TIDAK diambil. Data yang tidak pernah masuk ke
        // proses ini tidak bisa bocor karena salah tulis di kemudian hari.
        meter: {
          select: { zonaId: true },
        },
      },
    });

    const features: Array<Record<string, unknown>> = [];

    for (const z of zonaList) {
      if (z.batasGeo) {
        features.push({
          type: "Feature",
          geometry: z.batasGeo,
          properties: {
            id: z.id,
            nama: z.nama,
            tipe: "zona",
          },
        });
      }
    }

    /*
     * INSIDEN DIRINGKAS PER ZONA, BUKAN DITITIKKAN DI RUMAH ORANG.
     *
     * Versi sebelumnya memancarkan satu titik per insiden pada koordinat
     * meternya — yaitu koordinat rumah pelanggan — di endpoint yang bisa
     * diakses siapa saja tanpa login. Itu bertentangan dengan janji di kepala
     * berkas ini ("Tidak ada data pribadi (PII): … koordinat rumah"), dan
     * cukup untuk menunjukkan rumah mana yang sedang bermasalah.
     *
     * Peta operator (`src/rute/geo.ts`) tetap memberi koordinat persis —
     * di sana memang perlu, dan sudah dikunci peran OPERATOR/SUPERVISOR/
     * TEKNISI. Yang publik cukup tahu zona mana yang terdampak dan berapa
     * banyak insidennya.
     */
    const jumlahPerZona = new Map<string, number>();
    for (const i of insidenTerbuka) {
      const zonaId = i.meter?.zonaId;
      if (!zonaId) continue;
      jumlahPerZona.set(zonaId, (jumlahPerZona.get(zonaId) ?? 0) + 1);
    }

    for (const z of zonaList) {
      const jumlah = jumlahPerZona.get(z.id);
      if (!jumlah) continue;
      const fitur = features.find(
        (f) => (f.properties as { id?: string } | undefined)?.id === z.id,
      );
      if (fitur) {
        (fitur.properties as Record<string, unknown>).insidenTerbuka = jumlah;
      }
    }

    res.status(200).json({
      type: "FeatureCollection",
      features,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 6. GET /api/publik/panduan-lacak ────────────────────────────────── */

/**
 * Panduan melacak pengaduan + rapor janji layanan per kategori.
 *
 * Angka-angkanya DIHITUNG dari tabel `Tiket`, bukan dikarang. Yang statis di
 * sini hanya penjelasan PROSES (tahapan, kanal lapor, contoh format nomor) —
 * itu memang keterangan, bukan hasil pengukuran, jadi tidak ada yang
 * menyesatkan ketika ditulis sebagai konstanta.
 */
publikRouter.get("/panduan-lacak", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rentangHari = Math.max(1, Math.min(365, Number(req.query.rentang) || 30));
    const batasWaktu = new Date(Date.now() - rentangHari * 24 * 60 * 60 * 1000);

    const tiketList = await prisma.tiket.findMany({
      where: { dibuatPada: { gte: batasWaktu } },
      include: { meter: { include: { zona: true } } },
      orderBy: { selesaiPada: "desc" },
    });

    const selesai = tiketList.filter((t) => t.status === "SELESAI" && t.selesaiPada);
    const tepat = selesai.filter((t) => t.selesaiPada! <= t.slaJatuhTempo);

    const ketepatanPct =
      selesai.length > 0
        ? Number(((tepat.length / selesai.length) * 100).toFixed(1))
        : null;

    // Waktu tanggap = jeda sampai tiket PERTAMA KALI ditanggapi petugas.
    // Sumbernya kolom `ditanggapiPada`; lihat alasannya di /kinerja di atas.
    const ditanggapi = tiketList.filter((t) => t.ditanggapiPada !== null);
    const tanggapMenit =
      ditanggapi.length > 0
        ? Math.round(
            ditanggapi.reduce(
              (a, t) =>
                a +
                Math.max(
                  0,
                  (t.ditanggapiPada!.getTime() - t.dibuatPada.getTime()) / 60000,
                ),
              0,
            ) / ditanggapi.length,
          )
        : null;

    /*
     * Janji per kategori. Sumbernya JAM_SLA_KATEGORI — satu-satunya tempat
     * batas waktu itu didefinisikan, dan juga yang dipakai saat tiket dibuat.
     * Menyalin angkanya ke sini akan membuat janji publik dan perhitungan
     * internal bisa berbeda diam-diam.
     */
    const ALASAN_JANJI: Record<string, string> = {
      "kebocoran pipa": "Air terbuang terus-menerus dan bisa merusak jalan atau bangunan.",
      "air tidak mengalir": "Rumah tanpa air sama sekali tidak bisa menunggu lama.",
      "air keruh/berbau": "Perlu uji mutu dan pembilasan jaringan sebelum dinyatakan aman.",
      "tekanan lemah": "Air tetap mengalir, penanganan dijadwalkan bersama perbaikan zona.",
      "meter/keypad rusak": "Pasokan air tidak terganggu; penggantian alat menunggu suku cadang.",
      lainnya: "Kategori di luar daftar ditinjau petugas lebih dulu.",
    };

    const janji = Object.entries(JAM_SLA_KATEGORI).map(([kategori, janjiJam]) => {
      const milikKategori = tiketList.filter(
        (t) => t.kategori.toLowerCase() === kategori,
      );
      const selesaiKategori = milikKategori.filter(
        (t) => t.status === "SELESAI" && t.selesaiPada,
      );
      const tepatKategori = selesaiKategori.filter(
        (t) => t.selesaiPada! <= t.slaJatuhTempo,
      );
      return {
        kategori,
        janjiJam,
        alasan: ALASAN_JANJI[kategori] ?? "",
        masuk: milikKategori.length,
        tepat: tepatKategori.length,
        ketepatanPct:
          selesaiKategori.length > 0
            ? Number(((tepatKategori.length / selesaiKategori.length) * 100).toFixed(1))
            : 0,
      };
    });

    const selesaiTerbaru = selesai.slice(0, 8).map((t) => ({
      id: t.nomor,
      kategori: t.kategori,
      // Nama zona saja — bukan alamat, bukan ID meter (lihat catatan PII di atas).
      zona: t.meter?.zona?.nama ?? "Wilayah Pusat",
      lamaMenit: Math.max(
        0,
        Math.round((t.selesaiPada!.getTime() - t.dibuatPada.getTime()) / 60000),
      ),
      janjiJam: JAM_SLA_KATEGORI[t.kategori.toLowerCase()] ?? 48,
      selesaiPada: t.selesaiPada!.toISOString(),
      tepatWaktu: t.selesaiPada! <= t.slaJatuhTempo,
    }));

    res.status(200).json({
      rentangHari,
      targetPct: 90,
      ketepatanPct,
      tanggapMenit,
      janji,
      tahapan: [
        {
          kunci: "diterima",
          judul: "Laporan diterima",
          perkiraan: { jenis: "menit", menit: 1 },
          keterangan: "Nomor pengaduan terbit otomatis dan langsung bisa dilacak.",
        },
        {
          kunci: "ditinjau",
          judul: "Ditinjau petugas",
          perkiraan: { jenis: "teks", teks: "Pada jam kerja" },
          keterangan: "Petugas memeriksa kategori dan menentukan tingkat kedaruratan.",
        },
        {
          kunci: "ditugaskan",
          judul: "Ditugaskan ke teknisi",
          perkiraan: { jenis: "teks", teks: "Sesuai janji kategori" },
          keterangan: "Teknisi lapangan menerima tugas beserta lokasi zonanya.",
        },
        {
          kunci: "selesai",
          judul: "Selesai ditangani",
          perkiraan: { jenis: "teks", teks: "Tercatat di rapor kinerja" },
          keterangan:
            "Waktu selesai dibandingkan dengan janji kategori, dan hasilnya masuk ke angka ketepatan di halaman ini.",
        },
      ],
      kanal: [
        {
          kunci: "aplikasi",
          nama: "Portal Jernih",
          nilai: "Menu Pengaduan",
          tautan: "/masuk",
          jam: "24 jam",
          catatan: "Paling cepat terlacak karena nomor terbit seketika.",
        },
        {
          kunci: "telepon",
          nama: "Telepon pengaduan",
          nilai: "(022) 1500-123",
          tautan: "tel:+6222150123",
          jam: "06.00 – 22.00",
          catatan: "Untuk keadaan darurat seperti pipa pecah.",
        },
        {
          kunci: "whatsapp",
          nama: "WhatsApp",
          nilai: "0811-2000-123",
          tautan: "https://wa.me/628112000123",
          jam: "08.00 – 17.00",
          catatan: "Lampirkan foto supaya petugas membawa alat yang tepat.",
        },
      ],
      contoh: [
        { nomor: "LP-2026-10-0042", keterangan: "Format nomor pengaduan: LP-tahun-bulan-urutan." },
        { nomor: "LP-2026-09-0117", keterangan: "Nomor bulan sebelumnya tetap bisa dilacak." },
      ],
      selesaiTerbaru,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 7. GET /api/publik/riwayat-zona ─────────────────────────────────── */

/**
 * Rekam jejak keandalan layanan per zona.
 *
 * YANG DIHITUNG DARI DATA: keandalan, jumlah gangguan, total jam terganggu,
 * strip harian, dan daftar insiden — semuanya diturunkan dari tabel `Insiden`.
 *
 * YANG DIKEMBALIKAN `null` / KOSONG, DAN KENAPA: mutu air (klor, kekeruhan,
 * pH), pemeliharaan terjadwal, dan titik air darurat TIDAK pernah diukur atau
 * dicatat sistem ini — tidak ada tabelnya, tidak ada alatnya. Mengarangnya
 * supaya halaman terlihat penuh adalah hal yang paling berbahaya di portal
 * yang seluruh gagasannya transparansi: angka mutu air yang dikarang bisa
 * membuat orang menganggap air aman diminum.
 *
 * Kontrak di sisi FE memang sudah menyiapkan ini — `klorMgL: number | null`,
 * dan catatannya menyebut "nilai yang TIDAK dikirim server bertipe null,
 * bukan 0", karena 0 mg/L adalah hasil pengukuran yang sah.
 *
 * `ambang` memang konstanta: itu batas regulasi (Permenkes), bukan hasil
 * pengukuran, dan sengaja dikirim server supaya kalau regulasinya berubah,
 * seluruh penandaan "di luar ambang" ikut benar dari satu tempat.
 */
publikRouter.get("/riwayat-zona", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rentangHari = Math.max(1, Math.min(365, Number(req.query.rentang) || 30));
    const MS_HARI = 24 * 60 * 60 * 1000;
    const sekarang = Date.now();
    const mulaiPeriode = new Date(sekarang - rentangHari * MS_HARI);

    const [zonaList, insidenList] = await Promise.all([
      prisma.zona.findMany({ orderBy: { nama: "asc" } }),
      prisma.insiden.findMany({
        where: {
          OR: [
            { ditutupPada: null },
            { ditutupPada: { gte: mulaiPeriode } },
          ],
        },
        include: { meter: { select: { zonaId: true, penggunaId: true } } },
        orderBy: { dibukaPada: "desc" },
      }),
    ]);

    /** Insiden DITUGASKAN dianggap perbaikan; sisanya gangguan. */
    const jenisInsiden = (status: string) =>
      status === "DITUGASKAN" ? "perbaikan" : "gangguan";

    /** Irisan waktu insiden yang jatuh di dalam periode, dalam milidetik. */
    const msDalamPeriode = (dibuka: Date, ditutup: Date | null) => {
      const a = Math.max(dibuka.getTime(), mulaiPeriode.getTime());
      const b = Math.min(ditutup?.getTime() ?? sekarang, sekarang);
      return Math.max(0, b - a);
    };

    // Pelanggan terdampak dihitung dari meter yang BENAR-BENAR punya insiden,
    // bukan seluruh pelanggan di zona.
    const meterTerdampakPerZona = new Map<string, Set<string>>();
    for (const i of insidenList) {
      const z = i.meter?.zonaId;
      if (!z || !i.meterId) continue;
      if (!meterTerdampakPerZona.has(z)) meterTerdampakPerZona.set(z, new Set());
      meterTerdampakPerZona.get(z)!.add(i.meterId);
    }

    const zona = zonaList.map((z) => {
      const milikZona = insidenList.filter((i) => i.meter?.zonaId === z.id);
      const totalMs = milikZona.reduce(
        (a, i) => a + msDalamPeriode(i.dibukaPada, i.ditutupPada),
        0,
      );
      const totalJamTerganggu = Number((totalMs / 3_600_000).toFixed(1));
      const jamPeriode = rentangHari * 24;

      // Satu petak per hari, paling lama lebih dulu.
      const harian = Array.from({ length: rentangHari }, (_, idx) => {
        const awal = new Date(sekarang - (rentangHari - idx) * MS_HARI);
        const akhir = new Date(awal.getTime() + MS_HARI);
        const hariIni = milikZona.filter(
          (i) =>
            i.dibukaPada < akhir && (i.ditutupPada ?? new Date(sekarang)) > awal,
        );
        const status = hariIni.length === 0
          ? "normal"
          : hariIni.some((i) => jenisInsiden(i.status) === "gangguan")
            ? "gangguan"
            : "perbaikan";
        return { tanggal: awal.toISOString(), status };
      });

      return {
        id: z.id,
        nama: z.nama,
        keandalanPct:
          jamPeriode > 0
            ? Number(
                Math.max(0, 100 - (totalJamTerganggu / jamPeriode) * 100).toFixed(1),
              )
            : null,
        jumlahGangguan: milikZona.length,
        totalJamTerganggu,
        harian,
        // Belum ada alat uji mutu yang terhubung — jangan dikarang.
        kualitas: {
          klorMgL: null,
          kekeruhanNtu: null,
          ph: null,
          diujiPada: null,
          titikUji: null,
        },
      };
    });

    const berkeandalan = zona.filter((z) => z.keandalanPct !== null);
    const keandalanJaringanPct =
      berkeandalan.length > 0
        ? Number(
            (
              berkeandalan.reduce((a, z) => a + (z.keandalanPct ?? 0), 0) /
              berkeandalan.length
            ).toFixed(1),
          )
        : null;

    const namaZona = new Map(zonaList.map((z) => [z.id, z.nama]));

    const insiden = insidenList.map((i) => {
      const ms = msDalamPeriode(i.dibukaPada, i.ditutupPada);
      const zonaId = i.meter?.zonaId ?? "";
      return {
        id: i.id,
        zonaId,
        zonaNama: namaZona.get(zonaId) ?? "Wilayah Pusat",
        jenis: jenisInsiden(i.status),
        mulai: i.dibukaPada.toISOString(),
        selesai: i.ditutupPada?.toISOString() ?? null,
        durasiJam: Number((ms / 3_600_000).toFixed(1)),
        sebab: i.judul,
        pelangganTerdampak: meterTerdampakPerZona.get(zonaId)?.size ?? 0,
      };
    });

    res.status(200).json({
      periode: {
        mulai: mulaiPeriode.toISOString(),
        selesai: new Date(sekarang).toISOString(),
        hari: rentangHari,
      },
      ambang: {
        klor: [0.2, 0.5],
        kekeruhanMaks: 3,
        ph: [6.5, 8.5],
        acuan: "Permenkes No. 2 Tahun 2023 tentang Standar Baku Mutu Air Minum",
      },
      keandalanJaringanPct,
      zona,
      insiden,
      // Belum ada tabel jadwal pemeliharaan maupun titik air darurat.
      pemeliharaan: [],
      titikAir: [],
      kontak: [
        {
          jenis: "telepon",
          label: "Pengaduan darurat",
          nilai: "(022) 1500-123",
          keterangan: "06.00 – 22.00, untuk pipa pecah dan air mati total.",
        },
        {
          jenis: "whatsapp",
          label: "WhatsApp pengaduan",
          nilai: "0811-2000-123",
          keterangan: "08.00 – 17.00, sertakan foto lokasi.",
        },
        {
          jenis: "surel",
          label: "Surel",
          nilai: "pengaduan@jernih.id",
          keterangan: "Untuk keluhan yang perlu lampiran dokumen.",
        },
      ],
      ts: new Date(sekarang).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
