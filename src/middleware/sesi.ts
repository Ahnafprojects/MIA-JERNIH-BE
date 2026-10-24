/**
 * Penjaga rute: siapa yang sedang masuk, dan boleh apa.
 *
 * Inilah penjaga yang SUNGGUHAN. Frontend juga menyembunyikan tombol menurut
 * peran, tapi itu kenyamanan tampilan, bukan keamanan — siapa pun bisa
 * memanggil endpoint-nya langsung. Penolakan yang berlaku adalah yang di
 * berkas ini.
 */
import type { NextFunction, Request, Response } from "express";
import type { Peran } from "@prisma/client";
import { bacaAkses } from "../lib/auth.js";
import { forbidden, unauthorized } from "../lib/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      pengguna?: { id: string; peran: Peran };
    }
  }
}

/**
 * Mengambil token dari kepala Authorization ATAU cookie.
 *
 * Keduanya didukung dengan sengaja: aplikasi web memakai cookie (aman dari
 * XSS kalau httpOnly), sementara alat uji dan klien pihak ketiga memakai
 * kepala Bearer. Mendukung satu saja akan memaksa salah satunya memakai
 * jalan memutar.
 */
function ambilToken(req: Request): string | null {
  const kepala = req.headers.authorization;
  if (kepala?.startsWith("Bearer ")) return kepala.slice(7).trim() || null;
  const dariCookie = (req.cookies as Record<string, string> | undefined)?.akses;
  return dariCookie || null;
}

/** Wajib sudah masuk. Menempelkan `req.pengguna`. */
export async function wajibMasuk(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = ambilToken(req);
    if (!token) {
      throw unauthorized("Anda perlu masuk untuk membuka halaman ini.");
    }
    const isi = await bacaAkses(token);
    req.pengguna = { id: isi.sub, peran: isi.peran };
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Wajib salah satu peran.
 *
 * Pesannya SENGAJA menyebut peran yang dibutuhkan. "Akses ditolak" tanpa
 * penjelasan membuat petugas mengira sistemnya rusak lalu melapor ke IT,
 * padahal akunnya memang tidak berhak — dan itu memakan waktu dua pihak.
 */
export function wajibPeran(...boleh: Peran[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.pengguna) {
      next(unauthorized("Anda perlu masuk untuk membuka halaman ini."));
      return;
    }
    if (!boleh.includes(req.pengguna.peran)) {
      next(
        forbidden(
          `Halaman ini hanya untuk ${boleh.join(" atau ")}. Akun Anda berperan ${req.pengguna.peran}.`,
          "PERAN_TIDAK_CUKUP",
        ),
      );
      return;
    }
    next();
  };
}

/** Membaca pengguna kalau ada, tapi TIDAK menolak kalau tidak ada. */
export async function sesiOpsional(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const token = ambilToken(req);
  if (token) {
    try {
      const isi = await bacaAkses(token);
      req.pengguna = { id: isi.sub, peran: isi.peran };
    } catch {
      // Token kedaluwarsa pada rute publik bukan galat — halamannya memang
      // bisa dibuka tanpa masuk. Diamkan dan lanjutkan sebagai tamu.
    }
  }
  next();
}
