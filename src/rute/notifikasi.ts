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

/* ── 1b. PATCH /api/notifikasi/baca-semua ────────────────────────────── */

/**
 * Tandai seluruh notifikasi milik pengguna sebagai terbaca, sekaligus.
 *
 * Sebelumnya frontend mengirim satu PATCH per notifikasi untuk tombol
 * "Tandai semua". Lima puluh notifikasi berarti lima puluh permintaan, dan
 * kalau satu di tengahnya gagal, sebagian tertandai sementara layar sudah
 * menganggap semuanya terbaca.
 *
 * Aturan `Broadcast.dibuka` tetap sama dengan rute satuan di bawah: naik
 * satu kali per pengguna, hanya untuk notifikasi yang SEBELUMNYA belum
 * dibaca. Karena itu yang dihitung adalah baris belum terbaca, sebelum
 * penandaannya dijalankan, dan keduanya di dalam satu transaksi.
 */
notifikasiRouter.patch(
  "/baca-semua",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const penggunaId = req.pengguna!.id;
      const sekarang = new Date();

      const ditandai = await prisma.$transaction(async (tx) => {
        const belum = await tx.notifikasi.findMany({
          where: { penggunaId, dibacaPada: null },
          select: { broadcastId: true },
        });
        if (belum.length === 0) return 0;

        const perBroadcast = new Map<string, number>();
        for (const n of belum) {
          if (n.broadcastId) {
            perBroadcast.set(n.broadcastId, (perBroadcast.get(n.broadcastId) ?? 0) + 1);
          }
        }

        const hasil = await tx.notifikasi.updateMany({
          where: { penggunaId, dibacaPada: null },
          data: { dibacaPada: sekarang },
        });

        for (const [broadcastId, jumlah] of perBroadcast) {
          await tx.broadcast.update({
            where: { id: broadcastId },
            data: { dibuka: { increment: jumlah } },
          });
        }

        return hasil.count;
      });

      res.status(200).json({ ok: true, ditandai, belumDibaca: 0 });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 2. PATCH /api/notifikasi/:id/baca ───────────────────────────────── */

notifikasiRouter.patch("/:id/baca", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
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

