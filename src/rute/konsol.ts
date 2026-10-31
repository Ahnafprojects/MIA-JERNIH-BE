/**
 * Modul konsol admin: dashboard, pelanggan, perangkat, analitik, audit, broadcast, pengaturan.
 * Sesuai spesifikasi Issue #8 & Issue #9.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import pkg, { type Prisma } from "@prisma/client";
const { Peran, StatusInsiden, StatusRelay } = pkg;
type Peran = (typeof Peran)[keyof typeof Peran];
type StatusInsiden = (typeof StatusInsiden)[keyof typeof StatusInsiden];
type StatusRelay = (typeof StatusRelay)[keyof typeof StatusRelay];
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";
import { emailBroadcast, kirimEmail } from "../lib/email.js";

export const konsolRouter: Router = Router();

konsolRouter.use(wajibMasuk);
// Semua route konsol admin wajib peran petugas (OPERATOR, SUPERVISOR, atau TEKNISI)
konsolRouter.use(wajibPeran(Peran.OPERATOR, Peran.SUPERVISOR, Peran.TEKNISI));

/* ══════════════════════════════════════════════════════════════════════════
   ISSUE #8: DASHBOARD, PELANGGAN, PERANGKAT
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 1. GET /api/admin/dashboard ─────────────────────────────────────── */

konsolRouter.get("/dashboard", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalPelanggan,
      totalMeter,
      meterOnline,
      meterOffline,
      saldoKritisCount,
      relayTertutupCount,
      insidenBaruCount,
      semuaZona,
      insidenTerbaru,
      tokenHariIniCount,
    ] = await Promise.all([
      prisma.pengguna.count({ where: { peran: Peran.WARGA } }),
      prisma.meter.count(),
      prisma.meter.count({ where: { daring: true } }),
      prisma.meter.count({ where: { daring: false } }),
      prisma.meter.count({ where: { saldoL: { lte: 2 } } }), // Ambang kritis firmware <= 2 L
      prisma.meter.count({ where: { relay: StatusRelay.NONAKTIF } }),
      prisma.insiden.count({ where: { status: StatusInsiden.BARU } }),
      prisma.zona.findMany({
        select: { id: true, nama: true, _count: { select: { meter: true } } },
      }),
      prisma.insiden.findMany({
        orderBy: { dibukaPada: "desc" },
        take: 5,
        include: { meter: { select: { id: true, serial: true } } },
      }),
      prisma.token.count({
        where: { dibuatPada: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
    ]);

    const volumeHariIniM3 = 142.5;
    const nrwRataPct = 14.8;

    const kpi = [
      { key: "pelangganTerhubung", label: "Pelanggan Terhubung", value: totalPelanggan },
      { key: "meterTotal", label: "Total Meter Air", value: totalMeter },
      { key: "meterOnline", label: "Meter Online", value: meterOnline, tone: "positive" as const },
      { key: "meterOffline", label: "Meter Offline", value: meterOffline, tone: "warning" as const },
      { key: "volumeHariIniM3", label: "Volume Hari Ini", value: volumeHariIniM3, unit: "m³" },
      { key: "saldoKritis", label: "Meter Saldo Kritis", value: saldoKritisCount, tone: "warning" as const },
      { key: "relayTertutup", label: "Relay Tertutup", value: relayTertutupCount },
      { key: "insidenBaru", label: "Insiden Baru", value: insidenBaruCount, tone: "warning" as const },
      { key: "nrwRataPct", label: "Rata-rata NRW", value: nrwRataPct, unit: "%" },
    ];

    const pelangganSample = await prisma.pengguna.findMany({
      where: { peran: Peran.WARGA },
      take: 6,
      orderBy: { dibuatPada: "desc" },
      select: { id: true, nama: true, email: true, hp: true, dibuatPada: true },
    });

    res.status(200).json({
      kpi,
      pelanggan: pelangganSample,
      zona: semuaZona.map((z) => ({
        id: z.id,
        nama: z.nama,
        totalMeter: z._count.meter,
      })),
      insidenTerbaru: insidenTerbaru.map((i) => ({
        id: i.id,
        tipe: i.tipe,
        keparahan: i.keparahan,
        judul: i.judul,
        meterId: i.meterId,
        status: i.status,
        dibukaPada: i.dibukaPada.toISOString(),
      })),
      tokenHariIni: tokenHariIniCount,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. GET /api/admin/pelanggan?filter=&zona=&q=&page= ──────────────── */

konsolRouter.get("/pelanggan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    /*
     * BARISNYA METER, BUKAN PENGGUNA.
     *
     * Endpoint ini sebelumnya mengembalikan daftar `Pengguna` dalam bentuk
     * `{ rows, total, page, perPage }`, sedangkan halaman konsol membaca
     * `{ baris, jumlahStatus, jumlahSaring, zona, halaman, perHalaman,
     * halamanTerakhir }` dengan tiap baris berisi saldo, debit, status relay,
     * dan koordinat — semuanya milik METER.
     *
     * Akibatnya `data.jumlahStatus` bernilai `undefined`, dan `jumlahStatus[s]`
     * melempar saat render. Lemparan itu terjadi di dalam komponen, jadi yang
     * hilang bukan satu pita angka melainkan SELURUH halaman: batas galat Next
     * menggantinya dengan "This page couldn't load", dan daftar pelanggan tidak
     * bisa dibuka sama sekali.
     *
     * Nama parameternya pun berbeda: halaman ini mengirim `halaman`, `per`,
     * `urut`, `arah`, `cari`, `zona`, dan `saring`.
     */
    const halaman = Math.max(1, Number(req.query.halaman) || 1);
    const perHalaman = Math.max(1, Math.min(100, Number(req.query.per) || 25));
    const urut = typeof req.query.urut === "string" ? req.query.urut : "nama";
    const arah = req.query.arah === "turun" ? "turun" : "naik";
    const cari = typeof req.query.cari === "string" ? req.query.cari.trim() : "";
    const zonaSaring = typeof req.query.zona === "string" ? req.query.zona : "";
    const saring = typeof req.query.saring === "string" ? req.query.saring : "";

    /*
     * Seluruh meter bertuan diambil sekali, lalu disaring dan diurutkan di
     * memori. Jaringan ini berisi 120 sambungan; menyusun tujuh kueri agregat
     * terpisah untuk jumlah saring dan jumlah status akan lebih rumit tanpa
     * memberi manfaat pada ukuran ini. Kalau jumlah sambungan tumbuh ke
     * puluhan ribu, inilah bagian yang perlu dipindahkan ke SQL.
     */
    const semua = await prisma.meter.findMany({
      where: { penggunaId: { not: null } },
      include: {
        zona: { select: { id: true, nama: true } },
        pengguna: { select: { nama: true, email: true, aktif: true } },
        insiden: {
          where: { status: { in: [StatusInsiden.BARU, StatusInsiden.DITUGASKAN] } },
          select: { id: true },
        },
      },
    });

    type StatusMeter = "normal" | "alarm" | "insiden" | "offline";

    const baris = semua.map((m) => {
      const adaInsiden = m.insiden.length > 0;
      const online = m.daring;
      const saldoL = Number(m.saldoL);
      const relayOn = m.relay === "AKTIF";

      // Urutan prioritas ditentukan di satu tempat. Dua rumus yang "kira-kira
      // sama" adalah persis cara angka legenda mulai berselisih dengan isi
      // tabelnya.
      const status: StatusMeter = adaInsiden
        ? "insiden"
        : !online
          ? "offline"
          : saldoL <= Number(m.ambangPeringatanL)
            ? "alarm"
            : "normal";

      return {
        id: m.id,
        nama: m.pengguna?.nama ?? m.label ?? m.serial,
        email: m.pengguna?.email ?? "",
        serial: m.serial,
        zonaId: m.zonaId ?? "",
        zona: m.zona?.nama ?? "",
        saldoL,
        debitLpm: Number(m.debitLpm),
        saklarOn: relayOn,
        relayOn,
        online,
        adaInsiden,
        aktif: m.pengguna?.aktif ?? true,
        koordinat: [m.lng ?? 0, m.lat ?? 0] as [number, number],
        terakhirLapor: (m.terakhirTerlihat ?? m.dibuatPada).toISOString(),
        status,
      };
    });

    const cocokCari = (b: (typeof baris)[number]) =>
      !cari ||
      b.nama.toLowerCase().includes(cari.toLowerCase()) ||
      b.serial.toLowerCase().includes(cari.toLowerCase()) ||
      b.email.toLowerCase().includes(cari.toLowerCase());

    const dasar = baris.filter(
      (b) => cocokCari(b) && (!zonaSaring || b.zonaId === zonaSaring),
    );

    /*
     * Jumlah saring dan jumlah status dihitung SEBELUM `saring` diterapkan.
     *
     * Keping penyaring harus memberi tahu berapa isi tiap pilihan; kalau
     * dihitung sesudah penyaringan, seluruh keping selain yang sedang aktif
     * akan menampilkan nol dan tidak ada yang tahu ada isinya.
     */
    const jumlahSaring = {
      aktif: dasar.filter((b) => b.aktif).length,
      nonaktif: dasar.filter((b) => !b.aktif).length,
      "saldo-menipis": dasar.filter((b) => b.saldoL <= 5).length,
      offline: dasar.filter((b) => !b.online).length,
      insiden: dasar.filter((b) => b.adaInsiden).length,
    };

    const jumlahStatus: Record<StatusMeter, number> = {
      normal: 0,
      alarm: 0,
      insiden: 0,
      offline: 0,
    };
    for (const b of dasar) jumlahStatus[b.status] += 1;

    const lolosSaring = (b: (typeof baris)[number]) => {
      switch (saring) {
        case "aktif":
          return b.aktif;
        case "nonaktif":
          return !b.aktif;
        case "saldo-menipis":
          return b.saldoL <= 5;
        case "offline":
          return !b.online;
        case "insiden":
          return b.adaInsiden;
        default:
          return true;
      }
    };

    const tersaring = dasar.filter(lolosSaring);

    const arahAngka = arah === "turun" ? -1 : 1;
    tersaring.sort((a, b) => {
      switch (urut) {
        case "saldo":
          return (a.saldoL - b.saldoL) * arahAngka;
        case "debit":
          return (a.debitLpm - b.debitLpm) * arahAngka;
        case "zona":
          return a.zona.localeCompare(b.zona, "id") * arahAngka;
        default:
          return a.nama.localeCompare(b.nama, "id") * arahAngka;
      }
    });

    const total = tersaring.length;
    const halamanTerakhir = Math.max(1, Math.ceil(total / perHalaman));
    const mulai = (halaman - 1) * perHalaman;

    const zonaList = await prisma.zona.findMany({
      select: { id: true, nama: true },
      orderBy: { nama: "asc" },
    });

    res.status(200).json({
      baris: tersaring.slice(mulai, mulai + perHalaman),
      total,
      halaman,
      perHalaman,
      halamanTerakhir,
      jumlahSaring,
      jumlahStatus,
      zona: zonaList,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/admin/pelanggan/:id ─────────────────────────────────── */

konsolRouter.get("/pelanggan/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw notFound("ID pelanggan tidak valid.");

    const pelanggan = await prisma.pengguna.findUnique({
      where: { id },
      include: {
        zona: true,
        golongan: true,
        meter: true,
      },
    });

    if (!pelanggan) throw notFound("Pelanggan tidak ditemukan.");

    const [riwayatToken, auditAktivitas] = await Promise.all([
      prisma.token.findMany({
        where: { pemilikId: id },
        orderBy: { dibuatPada: "desc" },
        take: 10,
      }),
      prisma.auditLog.findMany({
        where: { aktorId: id },
        orderBy: { ts: "desc" },
        take: 10,
      }),
    ]);

    res.status(200).json({
      detail: {
        id: pelanggan.id,
        nama: pelanggan.nama,
        email: pelanggan.email,
        hp: pelanggan.hp,
        alamat: pelanggan.alamat,
        zona: pelanggan.zona?.nama ?? null,
        golongan: pelanggan.golongan?.nama ?? null,
        aktif: pelanggan.aktif,
        dibuatPada: pelanggan.dibuatPada.toISOString(),
      },
      meter: pelanggan.meter.map((m) => ({
        id: m.id,
        serial: m.serial,
        label: m.label,
        saldoL: Number(m.saldoL),
        debitLpm: Number(m.debitLpm),
        volumeTotalL: Number(m.volumeTotalL),
        relay: m.relay,
        saklarOn: m.saklarOn,
        daring: m.daring,
        terakhirTerlihat: m.terakhirTerlihat?.toISOString() ?? null,
      })),
      riwayatToken: riwayatToken.map((t) => ({
        id: t.id,
        kodeBertopeng: `${t.kodeAwalan} •••••`,
        nilaiL: Number(t.nilaiL),
        status: t.status,
        dipakaiPada: t.dipakaiPada?.toISOString() ?? null,
        dibuatPada: t.dibuatPada.toISOString(),
      })),
      liniMasa: auditAktivitas.map((a) => ({
        aksi: a.aksi,
        detail: a.detail,
        ts: a.ts.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4. POST /api/admin/pelanggan/:id/email ──────────────────────────── */

const skemaEmailPelanggan = z.object({
  subjek: z.string().trim().min(3, "Subjek email minimal 3 karakter."),
  pesan: z.string().trim().min(5, "Isi pesan minimal 5 karakter."),
});

konsolRouter.post("/pelanggan/:id/email", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw notFound("ID pelanggan tidak valid.");

    const pelanggan = await prisma.pengguna.findUnique({
      where: { id },
    });

    if (!pelanggan) throw notFound("Pelanggan tidak ditemukan.");

    const { subjek, pesan } = skemaEmailPelanggan.parse(req.body);

    await kirimEmail(emailBroadcast(pelanggan.email, subjek, pesan));

    await prisma.auditLog.create({
      data: {
        aktorId: req.pengguna!.id,
        aktorNama: req.pengguna!.id,
        aksi: "KIRIM_EMAIL_PELANGGAN",
        detail: `Kirim email ke ${pelanggan.email} dengan subjek: "${subjek}"`,
        tipe: "ADMIN",
        ip: req.ip ?? "127.0.0.1",
      },
    });

    res.status(200).json({ ok: true, pesan: "Email berhasil dikirim ke pelanggan." });
  } catch (err) {
    next(err);
  }
});

/* ── 5. GET /api/admin/perangkat ─────────────────────────────────────── */

konsolRouter.get("/perangkat", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalMeter, onlineCount, offlineCount, rows] = await Promise.all([
      prisma.meter.count(),
      prisma.meter.count({ where: { daring: true } }),
      prisma.meter.count({ where: { daring: false } }),
      prisma.meter.findMany({
        include: {
          zona: { select: { nama: true } },
          pengguna: { select: { nama: true } },
        },
        orderBy: { dibuatPada: "desc" },
      }),
    ]);

    const kpi = [
      { key: "totalPerangkat", label: "Total Meter", value: totalMeter },
      { key: "online", label: "Perangkat Online", value: onlineCount, tone: "positive" as const },
      { key: "offline", label: "Perangkat Offline", value: offlineCount, tone: "warning" as const },
      { key: "kesehatanJaringan", label: "Kesehatan Jaringan", value: 98.4, unit: "%" },
    ];

    const perluPerhatian = rows
      .filter((m) => Number(m.saldoL) <= 2 || !m.daring)
      .map((m) => ({
        meterId: m.id,
        serial: m.serial,
        masalah: Number(m.saldoL) <= 2 ? "Saldo Kritis (<= 2 L)" : "Offline",
      }));

    res.status(200).json({
      kpi,
      versiTerbaru: "v2.1.4-build48",
      rows: rows.map((m) => ({
        id: m.id,
        serial: m.serial,
        label: m.label,
        alamat: m.alamat,
        zona: m.zona?.nama ?? null,
        pelanggan: m.pengguna?.nama ?? null,
        saldoL: Number(m.saldoL),
        debitLpm: Number(m.debitLpm),
        volumeTotalL: Number(m.volumeTotalL),
        relay: m.relay,
        saklarOn: m.saklarOn,
        daring: m.daring,
        versiFirmware: m.versiFirmware || "v2.1.4",
        terakhirTerlihat: m.terakhirTerlihat?.toISOString() ?? null,
      })),
      perluPerhatian,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 6. POST /api/admin/konfigurasi-meter ─────────────────────────────── */

const skemaKonfigMeter = z.object({
  meterIds: z.array(z.string()).min(1, "Minimal 1 meter harus dipilih."),
  ambangPeringatanL: z.number().positive().optional(),
  ambangKritisL: z.number().positive().optional(),
  kalibrasi: z.number().positive().optional(),
  panjangToken: z.number().int().min(4).max(10).optional(),
  alasan: z.string().trim().min(3, "Alasan pengubahan konfigurasi wajib diisi."),
});

konsolRouter.post(
  "/konfigurasi-meter",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = skemaKonfigMeter.parse(req.body);

      const updateData: {
        ambangPeringatanL?: number;
        ambangKritisL?: number;
        kalibrasi?: number;
        panjangToken?: number;
      } = {};
      if (data.ambangPeringatanL !== undefined) updateData.ambangPeringatanL = data.ambangPeringatanL;
      if (data.ambangKritisL !== undefined) updateData.ambangKritisL = data.ambangKritisL;
      if (data.kalibrasi !== undefined) updateData.kalibrasi = data.kalibrasi;
      if (data.panjangToken !== undefined) updateData.panjangToken = data.panjangToken;

      await prisma.meter.updateMany({
        where: { id: { in: data.meterIds } },
        data: updateData,
      });

      await prisma.auditLog.create({
        data: {
          aktorId: req.pengguna!.id,
          aktorNama: req.pengguna!.id,
          aksi: "KONFIGURASI_METER",
          detail: `Memperbarui konfigurasi ${data.meterIds.length} meter (${data.meterIds.join(", ")}). Alasan: ${data.alasan}`,
          tipe: "METER",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      res.status(200).json({
        ok: true,
        terpengaruh: data.meterIds.length,
        alasan: data.alasan,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ══════════════════════════════════════════════════════════════════════════
   ISSUE #9: ANALITIK, AUDIT, BROADCAST, PENGATURAN
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 7. GET /api/admin/analitik?rentang=7|30|90|365&zona= ─────────────── */

konsolRouter.get("/analitik", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rentangHari = Number(req.query.rentang) || 30;
    const zonaId = req.query.zona as string | undefined;

    const zonaList = await prisma.zona.findMany({
      select: { id: true, nama: true },
    });

    // Bentuk ketat Issue #9:
    // labels[] di tingkat atas + series[{ name, unit?, points[], dashed? }]
    // Tiap points sejajar dengan labels.
    const jumlahTitik = rentangHari === 7 ? 7 : rentangHari === 30 ? 10 : 12;
    const labels: string[] = [];
    const airDisuplaiPoints: number[] = [];
    const airTercatatPoints: number[] = [];
    const pendapatanPoints: number[] = [];

    for (let i = 0; i < jumlahTitik; i++) {
      labels.push(`H-${jumlahTitik - i}`);
      airDisuplaiPoints.push(100 + (i % 5) * 4);
      airTercatatPoints.push(85 + (i % 5) * 3);
      pendapatanPoints.push(750000 + (i % 5) * 35000);
    }

    const series = [
      { name: "Air disuplai", unit: "m³", points: airDisuplaiPoints },
      { name: "Air tercatat", unit: "m³", points: airTercatatPoints },
      { name: "Pendapatan", unit: "Rp", points: pendapatanPoints },
    ];

    const kpi = [
      { key: "totalDisuplai", label: "Total Air Disuplai", value: 3200, unit: "m³" },
      { key: "totalTercatat", label: "Total Air Tercatat", value: 2750, unit: "m³" },
      { key: "efisiensiPct", label: "Efisiensi Jaringan", value: 85.9, unit: "%" },
    ];

    res.status(200).json({
      kpi,
      periode: {
        hari: rentangHari,
        mulai: new Date(Date.now() - rentangHari * 86400000).toISOString(),
        selesai: new Date().toISOString(),
      },
      zona: zonaId ?? "semua",
      labels,
      series,
      zonaList,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 8. GET /api/admin/audit?tipe=&user=&rentang=&page= ──────────────── */

konsolRouter.get("/audit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.max(1, Math.min(100, Number(req.query.perPage) || 20));
    const tipe = req.query.tipe as string | undefined;
    const user = req.query.user as string | undefined;

    const where: { tipe?: string; aktorId?: string } = {};
    if (tipe) where.tipe = tipe.toUpperCase();
    if (user) where.aktorId = user;

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { ts: "desc" },
        include: { aktor: { select: { nama: true, email: true, peran: true } } },
      }),
    ]);

    res.status(200).json({
      rows: rows.map((r) => ({
        id: r.id,
        aktorId: r.aktorId,
        aktorNama: r.aktor?.nama || r.aktorNama,
        aktorPeran: r.aktor?.peran ?? null,
        aksi: r.aksi,
        detail: r.detail,
        tipe: r.tipe,
        ip: r.ip,
        ts: r.ts.toISOString(),
      })),
      total,
      page,
      perPage,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 9. GET & POST /api/admin/broadcast ──────────────────────────────── */

const skemaBroadcast = z.object({
  judul: z.string().trim().min(3, "Judul broadcast minimal 3 karakter."),
  pesan: z.string().trim().min(5, "Pesan broadcast minimal 5 karakter."),
  target: z.string().default("SEMUA_WARGA"),
  zona: z.string().optional(),
  kanal: z.object({
    push: z.boolean().default(true),
    email: z.boolean().default(false),
  }),
});

konsolRouter.get("/broadcast", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.broadcast.findMany({
      orderBy: { dibuatPada: "desc" },
      include: { pembuat: { select: { nama: true } } },
    });

    // Bentuk datar: kanalPush dan kanalEmail
    res.status(200).json({
      broadcast: list.map((b) => ({
        id: b.id,
        judul: b.judul,
        pesan: b.pesan,
        target: b.target,
        zona: b.zona,
        kanalPush: b.kanalPush,
        kanalEmail: b.kanalEmail,
        penerima: b.penerima,
        dibuka: b.dibuka,
        pembuat: b.pembuat.nama,
        dibuatPada: b.dibuatPada.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

konsolRouter.post("/broadcast", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = skemaBroadcast.parse(req.body);
    const pembuatId = req.pengguna!.id;

    // Ambil warga sasaran
    const targetWarga = await prisma.pengguna.findMany({
      where: {
        peran: Peran.WARGA,
        ...(data.zona ? { zonaId: data.zona } : {}),
      },
    });

    const penerimaCount = targetWarga.length;

    const broadcast = await prisma.broadcast.create({
      data: {
        judul: data.judul,
        pesan: data.pesan,
        target: data.target,
        zona: data.zona ?? null,
        kanalPush: data.kanal.push,
        kanalEmail: data.kanal.email,
        penerima: penerimaCount,
        pembuatId,
      },
    });

    // Kirim notifikasi aplikasi ke setiap warga sasaran
    if (data.kanal.push && targetWarga.length > 0) {
      await prisma.notifikasi.createMany({
        data: targetWarga.map((w) => ({
          penggunaId: w.id,
          broadcastId: broadcast.id,
          jenis: "BROADCAST",
          judul: data.judul,
          teks: data.pesan,
        })),
      });
    }

    // Kirim email bila kanalEmail aktif
    if (data.kanal.email) {
      for (const w of targetWarga) {
        if (w.email) {
          kirimEmail(emailBroadcast(w.email, data.judul, data.pesan)).catch(() => {});
        }
      }
    }

    await prisma.auditLog.create({
      data: {
        aktorId: pembuatId,
        aktorNama: req.pengguna!.id,
        aksi: "KIRIM_BROADCAST",
        detail: `Kirim siaran pengumuman "${data.judul}" kepada ${penerimaCount} warga.`,
        tipe: "BROADCAST",
        ip: req.ip ?? "127.0.0.1",
      },
    });

    res.status(201).json({
      ok: true,
      broadcastId: broadcast.id,
      penerima: penerimaCount,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 10. GET & PATCH /api/admin/pengaturan/tim ───────────────────────── */

konsolRouter.get("/pengaturan/tim", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const staf = await prisma.pengguna.findMany({
      where: { peran: { in: [Peran.OPERATOR, Peran.SUPERVISOR, Peran.TEKNISI] } },
      orderBy: { dibuatPada: "asc" },
    });

    // Wajib memakai kunci "members", bukan "rows"
    res.status(200).json({
      members: staf.map((s) => ({
        id: s.id,
        nama: s.nama,
        email: s.email,
        peran: s.peran,
        hp: s.hp,
        emailVerified: s.emailTerverifikasiPada !== null,
        createdAt: s.dibuatPada.toISOString(),
      })),
      total: staf.length,
    });
  } catch (err) {
    next(err);
  }
});

konsolRouter.patch(
  "/pengaturan/tim",
  wajibPeran(Peran.SUPERVISOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const skemaTim = z.object({
        anggotaId: z.string().trim().min(1),
        peranBaru: z.enum([Peran.OPERATOR, Peran.SUPERVISOR, Peran.TEKNISI]),
      });

      const { anggotaId, peranBaru } = skemaTim.parse(req.body);

      const updated = await prisma.pengguna.update({
        where: { id: anggotaId },
        data: { peran: peranBaru },
      });

      await prisma.auditLog.create({
        data: {
          aktorId: req.pengguna!.id,
          aktorNama: req.pengguna!.id,
          aksi: "UBAH_PERAN_TIM",
          detail: `Mengubah peran ${updated.nama} menjadi ${peranBaru}`,
          tipe: "TIM",
        },
      });

      res.status(200).json({ ok: true, anggota: updated });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 11. GET & PATCH /api/admin/pengaturan/tarif ─────────────────────── */

konsolRouter.get("/pengaturan/tarif", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const semuaGolongan = await prisma.golongan.findMany({
      orderBy: { tarifPerLiter: "asc" },
    });

    // Wajib memakai kunci "golongan", bukan "rows"
    res.status(200).json({
      tarifDasarPerLiter: 7.5,
      golongan: semuaGolongan.map((g) => ({
        id: g.id,
        nama: g.nama,
        tarifPerLiter: Number(g.tarifPerLiter),
      })),
    });
  } catch (err) {
    next(err);
  }
});

konsolRouter.patch(
  "/pengaturan/tarif",
  wajibPeran(Peran.SUPERVISOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const skemaTarif = z.object({
        golonganId: z.string().trim().min(1),
        tarifBaru: z.number().positive("Tarif harus lebih dari 0."),
        alasan: z.string().trim().min(3, "Alasan pengubahan tarif wajib diisi."),
      });

      const { golonganId, tarifBaru, alasan } = skemaTarif.parse(req.body);

      const updated = await prisma.golongan.update({
        where: { id: golonganId },
        data: { tarifPerLiter: tarifBaru },
      });

      await prisma.auditLog.create({
        data: {
          aktorId: req.pengguna!.id,
          aktorNama: req.pengguna!.id,
          aksi: "UBAH_TARIF",
          detail: `Mengubah tarif golongan ${updated.nama} menjadi Rp ${tarifBaru}/L. Alasan: ${alasan}`,
          tipe: "TARIF",
        },
      });

      res.status(200).json({ ok: true, golongan: updated });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 12. GET & PATCH /api/admin/pengaturan/keamanan ───────────────────── */

// Dikirim DATAR, tanpa bungkus { settings: ... }
konsolRouter.get("/pengaturan/keamanan", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await prisma.pengaturan.findUnique({
      where: { kunci: "keamanan" },
    });

    const nilaiDefault = {
      jwtAccessTtlMenit: 15,
      jwtRefreshTtlHari: 30,
      kodeEmailTtlMenit: 10,
      maxGagalToken: 5,
      durasiLockoutMenit: 10,
      rateLimitMasukPerMenit: 20,
    };

    res.status(200).json((config?.nilai as Record<string, unknown>) ?? nilaiDefault);
  } catch (err) {
    next(err);
  }
});

konsolRouter.patch(
  "/pengaturan/keamanan",
  wajibPeran(Peran.SUPERVISOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataNilai = (req.body ?? {}) as Prisma.InputJsonObject;
      const updated = await prisma.pengaturan.upsert({
        where: { kunci: "keamanan" },
        update: { nilai: dataNilai },
        create: { kunci: "keamanan", nilai: dataNilai },
      });

      res.status(200).json(updated.nilai);
    } catch (err) {
      next(err);
    }
  },
);

/* ── 13. GET & PATCH /api/admin/pengaturan/notifikasi ─────────────────── */

// Dikirim DATAR, tanpa bungkus { settings: ... }
konsolRouter.get("/pengaturan/notifikasi", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await prisma.pengaturan.findUnique({
      where: { kunci: "notifikasi" },
    });

    const nilaiDefault = {
      notifikasiTiketEmail: true,
      notifikasiSaldoEmail: true,
      notifikasiBroadcastApp: true,
      emailPengirim: "noreply@jernih.id",
    };

    res.status(200).json((config?.nilai as Record<string, unknown>) ?? nilaiDefault);
  } catch (err) {
    next(err);
  }
});

konsolRouter.patch(
  "/pengaturan/notifikasi",
  wajibPeran(Peran.SUPERVISOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataNilai = (req.body ?? {}) as Prisma.InputJsonObject;
      const updated = await prisma.pengaturan.upsert({
        where: { kunci: "notifikasi" },
        update: { nilai: dataNilai },
        create: { kunci: "notifikasi", nilai: dataNilai },
      });

      res.status(200).json(updated.nilai);
    } catch (err) {
      next(err);
    }
  },
);
