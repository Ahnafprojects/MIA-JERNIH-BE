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

publikRouter.get("/lacak/:nomor", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nomor = Array.isArray(req.params.nomor) ? req.params.nomor[0] : req.params.nomor;
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

    let totalMenitTanggap = 0;
    let jumlahTiketTanggap = 0;
    for (const t of tiketList) {
      if (t.status === "DIPROSES" || t.status === "SELESAI") {
        const menit = Math.round(
          (t.diubahPada.getTime() - t.dibuatPada.getTime()) / 60000,
        );
        if (menit >= 0) {
          totalMenitTanggap += menit;
          jumlahTiketTanggap++;
        }
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

    const volumeTercatatM3 = Number(
      ((riwayatVolume._sum.volumeTotalL?.toNumber() ?? 0) / 1000).toFixed(1),
    );

    /*
     * NRW (air tak berekening) TIDAK dilaporkan sampai bisa dihitung.
     *
     * Sebelumnya nilainya dipatok `14.8` dan disajikan sebagai statistik
     * jaringan. Menghitungnya sungguhan butuh angka air yang DIPRODUKSI
     * (keluaran instalasi/induk), dan itu belum ada di basis data mana pun —
     * yang tercatat hanya yang terpakai di meter pelanggan.
     *
     * `null` jujur dan bisa disembunyikan antarmuka; angka karangan tidak
     * bisa ditarik kembali setelah dikutip orang.
     */
    const nrwRataPct: number | null = null;

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

    res.status(200).json({
      rentangHari,
      agregat: {
        totalMeter,
        totalPelanggan,
        totalZona,
        volumeTercatatM3,
        nrwRataPct,
      },
      distribusiZona,
    });
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
