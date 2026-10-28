/**
 * Modul meter: telemetri, kontrol relay, hubungkan meter.
 * Sesuai spesifikasi Issue #3.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { StatusRelay } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { wajibMasuk } from "../middleware/sesi.js";
import { log } from "../lib/log.js";

export const meterRouter: Router = Router();

/* ── Titik sambung pengiriman perintah ke firmware perangkat fisik ───── */

export function kirimKeMeter(
  meterId: string,
  perintah: Record<string, unknown>,
): Promise<{ sukses: boolean; tertunda?: boolean }> {
  // Pengiriman fisik ke firmware ESP32 di luar lingkup kompetisi;
  // fungsi ini bertindak sebagai antarmuka abstraksi yang aman.
  log.info({ meterId, perintah }, "[METER-COMMAND] Perintah disiapkan untuk meter");
  return Promise.resolve({ sukses: true });
}

/* ── Format 2 baris layar LCD standar firmware ───────────────────────── */

export function lcdUtama(data: {
  saldoL: number;
  saklarOn: boolean;
  debitLpm: number;
  volumeTotalL: number;
}): { baris1: string; baris2: string } {
  const saklarStr = data.saklarOn ? "ON" : "OFF";
  // Meniru format firmware: titik desimal, spasi tetap
  const baris1 = `S=${data.saldoL.toFixed(2)}L  ${saklarStr}`;
  const baris2 = `D=${data.debitLpm.toFixed(1)}   V=${data.volumeTotalL.toFixed(1)}`;
  return { baris1, baris2 };
}

/* ── Helper Pemeriksaan Hak Akses Meter ──────────────────────────────── */

async function pastikanAksesMeter(req: Request, meterId: string) {
  const meter = await prisma.meter.findUnique({
    where: { id: meterId },
    include: { zona: true },
  });

  if (!meter) {
    throw notFound(`Meter dengan ID ${meterId} tidak ditemukan.`);
  }

  const pengguna = req.pengguna!;
  if (pengguna.peran === "WARGA" && meter.penggunaId !== pengguna.id) {
    throw forbidden(
      "Anda tidak memiliki hak untuk mengakses data meter ini.",
      "BUKAN_PEMILIK_METER",
    );
  }

  return meter;
}

const skemaRelay = z.object({
  aksi: z.enum(["buka", "tutup"], {
    message: "Aksi relay harus 'buka' atau 'tutup'.",
  }),
  alasan: z.string().trim().min(3, "Alasan pengubahan relay wajib dicantumkan."),
});

const skemaHubungkan = z.object({
  idPelanggan: z.string().trim().optional(),
  qr: z.string().trim().optional(),
  meterId: z.string().trim().optional(),
});

meterRouter.use(wajibMasuk);

/* ── 1. GET /api/meter/:id ───────────────────────────────────────────── */

meterRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    const meter = await pastikanAksesMeter(req, id);
    const saldoL = Number(meter.saldoL);
    const debitLpm = Number(meter.debitLpm);
    const volumeTotalL = Number(meter.volumeTotalL);

    const lcd = lcdUtama({
      saldoL,
      saklarOn: meter.saklarOn,
      debitLpm,
      volumeTotalL,
    });

    res.status(200).json({
      meter: {
        id: meter.id,
        serial: meter.serial,
        label: meter.label,
        alamat: meter.alamat,
        zona: meter.zona?.nama ?? null,
        saldoL,
        debitLpm,
        volumeTotalL,
        relay: meter.relay,
        saklarOn: meter.saklarOn,
        daring: meter.daring,
        terakhirTerlihat: meter.terakhirTerlihat,
        versiFirmware: meter.versiFirmware,
      },
      lcd,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. GET /api/meter/:id/live ──────────────────────────────────────── */

meterRouter.get("/:id/live", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    const meter = await pastikanAksesMeter(req, id);
    const riwayatTerakhir = await prisma.riwayatMeter.findFirst({
      where: { meterId: meter.id },
      orderBy: { ts: "desc" },
    });

    res.status(200).json({
      meterId: meter.id,
      saldoL: Number(meter.saldoL),
      debitLpm: Number(meter.debitLpm),
      volumeTotalL: Number(meter.volumeTotalL),
      saklarOn: meter.saklarOn,
      relay: meter.relay,
      buzzer: riwayatTerakhir?.buzzer ?? "off",
      daring: meter.daring,
      ts: meter.terakhirTerlihat?.toISOString() ?? new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/meter/:id/pemakaian?rentang=hari|minggu|bulan ───────── */

meterRouter.get("/:id/pemakaian", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    await pastikanAksesMeter(req, id);
    const rentang = (req.query.rentang as string) || "minggu";

    let batasWaktu = new Date();
    if (rentang === "hari") {
      batasWaktu = new Date(Date.now() - 24 * 60 * 60 * 1000);
    } else if (rentang === "bulan") {
      batasWaktu = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } else {
      // Bawaan 8 hari untuk peta panas 7x24 jam
      batasWaktu = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    }

    const emberList = await prisma.emberPemakaian.findMany({
      where: {
        meterId: id,
        jam: { gte: batasWaktu },
      },
      orderBy: { jam: "asc" },
    });

    const deret = emberList.map((e) => ({
      waktu: e.jam.toISOString(),
      volumeL: Number(e.volumeL),
    }));

    res.status(200).json({
      meterId: id,
      rentang,
      deret,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4. GET /api/meter/:id/log ───────────────────────────────────────── */

meterRouter.get("/:id/log", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    await pastikanAksesMeter(req, id);

    const logKejadian = await prisma.riwayatMeter.findMany({
      where: { meterId: id },
      orderBy: { ts: "desc" },
      take: 20,
    });

    res.status(200).json({
      meterId: id,
      log: logKejadian.map((k) => ({
        ts: k.ts.toISOString(),
        saldoL: Number(k.saldoL),
        debitLpm: Number(k.debitLpm),
        saklarOn: k.saklarOn,
        relay: k.relay,
        buzzer: k.buzzer,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 5. POST /api/meter/:id/relay ────────────────────────────────────── */

meterRouter.post("/:id/relay", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    const meter = await pastikanAksesMeter(req, id);
    const { aksi, alasan } = skemaRelay.parse(req.body);

    const saldo = Number(meter.saldoL);

    if (aksi === "buka") {
      // Aturan ketat Issue #3: Relay hanya aktif bila saldoL > 0 DAN saklarOn
      if (saldo <= 0) {
        throw badRequest(
          "SALDO_HABIS",
          "Relay tidak dapat dibuka saat saldo air 0 liter.",
        );
      }
      if (!meter.saklarOn) {
        throw badRequest(
          "SAKLAR_OFF",
          "Relay tidak dapat dibuka karena saklar fisik pada meter dalam keadaan OFF.",
        );
      }
    }

    const statusBaru = aksi === "buka" ? StatusRelay.AKTIF : StatusRelay.NONAKTIF;

    await prisma.meter.update({
      where: { id: meter.id },
      data: { relay: statusBaru },
    });

    // Catat ke AuditLog
    const aktor = await prisma.pengguna.findUnique({
      where: { id: req.pengguna!.id },
      select: { nama: true },
    });

    await prisma.auditLog.create({
      data: {
        aktorId: req.pengguna!.id,
        aktorNama: aktor?.nama ?? "Pengguna",
        aksi: `RELAY_${aksi.toUpperCase()}`,
        detail: `Mengubah relay meter ${meter.id} ke status ${statusBaru}. Alasan: ${alasan}`,
        tipe: "METER",
        ip: req.ip ?? "127.0.0.1",
      },
    });

    await kirimKeMeter(meter.id, { aksi, statusBaru });

    res.status(200).json({
      ok: true,
      relay: statusBaru,
      alasan,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 6. POST /api/meter/hubungkan ────────────────────────────────────── */

meterRouter.post("/hubungkan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = skemaHubungkan.parse(req.body);
    const targetMeter = data.meterId || data.idPelanggan || data.qr;

    if (!targetMeter) {
      throw badRequest("DATA_TIDAK_LENGKAP", "ID meter atau kode QR harus diisi.");
    }

    const meter = await prisma.meter.findFirst({
      where: {
        OR: [{ id: targetMeter }, { serial: targetMeter }],
      },
    });

    if (!meter) {
      throw notFound("Meter tidak ditemukan.");
    }

    if (meter.penggunaId && meter.penggunaId !== req.pengguna!.id) {
      throw badRequest(
        "METER_SUDAH_TERHUBUNG",
        "Meter ini sudah terhubung ke akun pelanggan lain.",
      );
    }

    await prisma.meter.update({
      where: { id: meter.id },
      data: { penggunaId: req.pengguna!.id },
    });

    res.status(200).json({
      ok: true,
      meterId: meter.id,
      pesan: "Meter berhasil dihubungkan ke akun Anda.",
    });
  } catch (err) {
    next(err);
  }
});

/* ── 7. DELETE /api/meter/:id/hubungkan ──────────────────────────────── */

meterRouter.delete("/:id/hubungkan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID meter tidak valid.");

    const meter = await pastikanAksesMeter(req, id);

    await prisma.meter.update({
      where: { id: meter.id },
      data: { penggunaId: null },
    });

    res.status(200).json({
      ok: true,
      pesan: "Meter berhasil dilepas dari akun Anda.",
    });
  } catch (err) {
    next(err);
  }
});

