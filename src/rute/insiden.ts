/**
 * Modul insiden & alarm: deteksi otomatis dan pengelolaan petugas.
 * Sesuai spesifikasi Issue #7.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import pkg from "@prisma/client";
const { Keparahan, StatusInsiden, StatusRelay } = pkg;
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";

export const adminInsidenRouter: Router = Router();

/* ── Deteksi Insiden Otomatis ────────────────────────────────────────── */

export async function jalankanDeteksiInsidenOtomatis(): Promise<{
  baru: number;
  diperbarui: number;
}> {
  let baru = 0;
  let diperbarui = 0;
  const sekarang = new Date();

  const semuaMeter = await prisma.meter.findMany({
    include: { zona: true },
  });

  for (const meter of semuaMeter) {
    const saldo = Number(meter.saldoL);

    // 1. Deteksi Saldo Habis (saldo 0 dan relay nonaktif)
    if (saldo <= 0 && meter.relay === StatusRelay.NONAKTIF) {
      const ada = await prisma.insiden.findFirst({
        where: {
          meterId: meter.id,
          tipe: "saldo habis",
          status: { in: [StatusInsiden.BARU, StatusInsiden.DITUGASKAN] },
        },
      });

      if (ada) {
        await prisma.insiden.update({
          where: { id: ada.id },
          data: { detail: `Saldo meter 0 L sejak ${ada.dibukaPada.toLocaleTimeString("id-ID")}` },
        });
        diperbarui++;
      } else {
        await prisma.insiden.create({
          data: {
            meterId: meter.id,
            tipe: "saldo habis",
            keparahan: Keparahan.RINGAN,
            judul: `Saldo meter ${meter.id} habis`,
            detail: "Saldo 0 liter dan katup relay telah dimatikan secara otomatis.",
            status: StatusInsiden.BARU,
          },
        });
        baru++;
      }
    }

    // 2. Deteksi Sensor Offline (> 15 menit tidak ada laporan)
    // HANYA untuk meter yang sebelumnya berstatus daring / aktif
    if (meter.daring && meter.terakhirTerlihat) {
      const selisihMenit = (sekarang.getTime() - meter.terakhirTerlihat.getTime()) / 60000;
      if (selisihMenit > 15) {
        const ada = await prisma.insiden.findFirst({
          where: {
            meterId: meter.id,
            tipe: "sensor offline",
            status: { in: [StatusInsiden.BARU, StatusInsiden.DITUGASKAN] },
          },
        });

        if (ada) {
          await prisma.insiden.update({
            where: { id: ada.id },
            data: { detail: `Tidak ada telemetri sejak ${selisihMenit.toFixed(0)} menit lalu.` },
          });
          diperbarui++;
        } else {
          await prisma.insiden.create({
            data: {
              meterId: meter.id,
              tipe: "sensor offline",
              keparahan: Keparahan.SEDANG,
              judul: `Telemetri meter ${meter.id} terputus`,
              detail: `Sensor offline selama ${selisihMenit.toFixed(0)} menit.`,
              status: StatusInsiden.BARU,
            },
          });
          baru++;
        }
      }
    }
  }

  return { baru, diperbarui };
}

/* ── Validasi Zod ────────────────────────────────────────────────────── */

const skemaUbahInsiden = z.object({
  status: z.enum(["BARU", "DITUGASKAN", "SELESAI"]),
  teknisiId: z.string().trim().optional(),
  detail: z.string().trim().optional(),
});

adminInsidenRouter.use(wajibMasuk);
adminInsidenRouter.use(wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"));

/* ── 1. GET /api/admin/insiden?status=&zona= ─────────────────────────── */

adminInsidenRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const zona = req.query.zona as string | undefined;

    const where: { status?: StatusInsiden; meter?: { zonaId: string } } = {};
    if (status) where.status = status.toUpperCase() as StatusInsiden;
    if (zona) where.meter = { zonaId: zona };

    const rows = await prisma.insiden.findMany({
      where,
      orderBy: { dibukaPada: "desc" },
      include: {
        meter: {
          select: {
            id: true,
            serial: true,
            alamat: true,
            zona: { select: { id: true, nama: true } },
          },
        },
        teknisi: {
          select: { id: true, nama: true, hp: true },
        },
      },
    });

    res.status(200).json({
      insiden: rows.map((i) => ({
        id: i.id,
        tipe: i.tipe,
        keparahan: i.keparahan,
        judul: i.judul,
        detail: i.detail,
        status: i.status,
        meterId: i.meterId,
        zona: i.meter?.zona?.nama ?? null,
        teknisi: i.teknisi ? { nama: i.teknisi.nama, hp: i.teknisi.hp } : null,
        dibukaPada: i.dibukaPada.toISOString(),
        ditutupPada: i.ditutupPada?.toISOString() ?? null,
      })),
      total: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. PATCH /api/admin/insiden/:id ─────────────────────────────────── */

adminInsidenRouter.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw notFound("ID insiden tidak valid.");

    const { status, teknisiId, detail } = skemaUbahInsiden.parse(req.body);

    const insiden = await prisma.insiden.findUnique({
      where: { id },
    });

    if (!insiden) {
      throw notFound("Insiden tidak ditemukan.");
    }

    const statusBaru = status;
    const ditutupPada = statusBaru === StatusInsiden.SELESAI ? new Date() : insiden.ditutupPada;

    const updated = await prisma.insiden.update({
      where: { id },
      data: {
        status: statusBaru,
        teknisiId: teknisiId ?? insiden.teknisiId,
        ditutupPada,
        detail: detail ?? insiden.detail,
      },
    });

    // Catat ke AuditLog
    await prisma.auditLog.create({
      data: {
        aktorId: req.pengguna!.id,
        aktorNama: req.pengguna!.id,
        aksi: `INSIDEN_${statusBaru}`,
        detail: `Mengubah status insiden ${insiden.id} (${insiden.judul}) menjadi ${statusBaru}.`,
        tipe: "INSIDEN",
        ip: req.ip ?? "127.0.0.1",
      },
    });

    res.status(200).json({
      ok: true,
      insiden: updated,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. POST /api/admin/insiden/deteksi-manual ────────────────────────── */

adminInsidenRouter.post("/deteksi-manual", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const hasil = await jalankanDeteksiInsidenOtomatis();
    res.status(200).json({
      ok: true,
      pesan: `Deteksi selesai: ${hasil.baru} insiden baru, ${hasil.diperbarui} insiden diperbarui.`,
      hasil,
    });
  } catch (err) {
    next(err);
  }
});
