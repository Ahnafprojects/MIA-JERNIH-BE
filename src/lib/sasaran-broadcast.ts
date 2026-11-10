import { Peran } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Penentu penerima broadcast menurut `target`.
 *
 * ── Kenapa berkas ini ada ─────────────────────────────────────────────
 *
 * Sebelumnya `target` hanya DISIMPAN. Penerimanya selalu seluruh warga
 * (disaring zona bila ada), apa pun pilihannya. Operator yang memilih
 * "Saldo rendah" untuk mengingatkan segelintir orang justru mengirim
 * pengumuman ke 420 warga, dan riwayat broadcast tetap menulis
 * `SALDO_RENDAH` seolah penyaringannya terjadi. Itu dua kesalahan sekaligus:
 * warga yang tidak berkepentingan terganggu, dan catatannya berbohong.
 *
 * Pilihan `TUNGGAKAN` yang dulu ada di formulir DIHAPUS, bukan
 * diimplementasikan. Produk ini prabayar: air hanya mengalir selama saldo
 * ada, jadi tidak ada pemakaian yang bisa menunggak. Target yang mustahil
 * punya penerima hanya akan menjanjikan penyaringan yang tidak bermakna.
 *
 * ── Arti tiap target ──────────────────────────────────────────────────
 *
 * - `SEMUA_WARGA` seluruh warga yang akunnya aktif.
 * - `ZONA`        warga di satu zona. Zonanya WAJIB.
 * - `SALDO_RENDAH` warga yang memegang sedikitnya satu meter dengan saldo
 *                 di bawah atau sama dengan ambang alarm meter itu sendiri
 *                 (`Meter.ambangPeringatanL`, bawaan 5 L). Yang dipakai
 *                 ambang METER, bukan ambang peringatan milik warga, supaya
 *                 angkanya sama dengan yang dibaca operator di dasbor.
 *
 * `zona` boleh dipakai bersama target mana pun untuk mempersempitnya.
 */

export const TARGET_BROADCAST = [
  "SEMUA_WARGA",
  "ZONA",
  "SALDO_RENDAH",
] as const;

export type TargetBroadcast = (typeof TARGET_BROADCAST)[number];

export interface WargaSasaran {
  id: string;
  email: string;
  telegramChatId: string | null;
}

export async function wargaSasaranBroadcast(
  target: TargetBroadcast,
  zonaId: string | undefined,
): Promise<WargaSasaran[]> {
  const dasar = {
    peran: Peran.WARGA,
    aktif: true,
    ...(zonaId ? { zonaId } : {}),
  };
  const pilih = { id: true, email: true, telegramChatId: true } as const;

  switch (target) {
    case "SEMUA_WARGA":
    case "ZONA":
      return prisma.pengguna.findMany({ where: dasar, select: pilih });

    case "SALDO_RENDAH": {
      /*
       * Prisma tidak bisa membandingkan dua kolom di dalam `where`
       * (`saldoL <= ambangPeringatanL`), jadi perbandingannya dikerjakan di
       * sini. Jumlah meter warga ratusan, bukan jutaan; satu kueri lalu
       * saring di memori jauh lebih sederhana daripada SQL mentah.
       */
      const meter = await prisma.meter.findMany({
        where: { pengguna: dasar },
        select: { penggunaId: true, saldoL: true, ambangPeringatanL: true },
      });
      const idRendah = new Set(
        meter
          .filter((m) => m.saldoL.lessThanOrEqualTo(m.ambangPeringatanL))
          .map((m) => m.penggunaId)
          .filter((id): id is string => id !== null),
      );
      if (idRendah.size === 0) return [];
      return prisma.pengguna.findMany({
        where: { ...dasar, id: { in: [...idRendah] } },
        select: pilih,
      });
    }
  }
}
