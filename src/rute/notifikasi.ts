/**
 * Modul notifikasi pengguna dan pembacaan pesan broadcast.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { wajibMasuk } from "../middleware/sesi.js";

export const notifikasiRouter: Router = Router();

notifikasiRouter.use(wajibMasuk);

/* ── 1. GET /api/notifikasi ──────────────────────────────────────────── */

notifikasiRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const penggunaId = req.pengguna!.id;

    const notifikasiList = await prisma.notifikasi.findMany({
      where: { penggunaId },
      orderBy: { dibuatPada: "desc" },
      take: 50,
    });

    const belumDibaca = await prisma.notifikasi.count({
      where: { penggunaId, dibacaPada: null },
    });

    res.status(200).json({
      notifikasi: notifikasiList.map((n) => ({
        id: n.id,
        jenis: n.jenis,
        judul: n.judul,
        teks: n.teks,
        tautan: n.tautan,
        dibaca: n.dibacaPada !== null,
        dibacaPada: n.dibacaPada?.toISOString() ?? null,
        dibuatPada: n.dibuatPada.toISOString(),
      })),
      belumDibaca,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. PATCH /api/notifikasi/:id/baca ───────────────────────────────── */

notifikasiRouter.patch("/:id/baca", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID notifikasi tidak valid.");

    const penggunaId = req.pengguna!.id;

    const notif = await prisma.notifikasi.findFirst({
      where: { id, penggunaId },
    });

    if (!notif) {
      throw notFound("Notifikasi tidak ditemukan.");
    }

    // Aturan ketat Issue #9:
    // Broadcast.dibuka HANYA naik satu kali per pengguna, pada transisi dibacaPada: null -> terisi.
    if (!notif.dibacaPada) {
      await prisma.$transaction([
        prisma.notifikasi.update({
          where: { id: notif.id },
          data: { dibacaPada: new Date() },
        }),
        ...(notif.broadcastId
          ? [
              prisma.broadcast.update({
                where: { id: notif.broadcastId },
                data: { dibuka: { increment: 1 } },
              }),
            ]
          : []),
      ]);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

