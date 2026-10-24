/**
 * Primitif autentikasi: kata sandi, JWT akses, refresh token, dan kode email.
 *
 * Dipisah dari routernya supaya modul lain (meter, token, konsol) bisa
 * memverifikasi pengguna tanpa menarik seluruh alur masuk.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { Peran } from "@prisma/client";
import { env } from "../env.js";
import { unauthorized } from "./errors.js";

export interface IsiAkses {
  sub: string;
  peran: Peran;
}

const kunci = () => new TextEncoder().encode(env().JWT_SECRET);

/* ── Kata sandi ──────────────────────────────────────────────────────── */

/*
 * argon2id, bukan bcrypt.
 *
 * bcrypt memotong masukan di 72 bita — kata sandi panjang atau frasa sandi
 * ber-emoji diam-diam kehilangan ekornya, dan dua sandi berbeda bisa jadi
 * cocok. argon2id tidak punya batas itu dan menahan serangan GPU lebih baik.
 */
export const hashSandi = (sandi: string) =>
  argon2.hash(sandi, { type: argon2.argon2id });

export async function sandiCocok(hash: string, sandi: string) {
  try {
    return await argon2.verify(hash, sandi);
  } catch {
    // Hash rusak atau format lama. Diperlakukan sebagai tidak cocok, bukan
    // dilempar: kegagalan verifikasi tidak boleh membedakan "sandi salah"
    // dari "data rusak" di mata penyerang.
    return false;
  }
}

/* ── JWT akses ───────────────────────────────────────────────────────── */

export async function buatAkses(isi: IsiAkses): Promise<string> {
  return new SignJWT({ peran: isi.peran })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(isi.sub)
    .setIssuedAt()
    .setExpirationTime(`${env().ACCESS_TTL_MENIT}m`)
    .sign(kunci());
}

export async function bacaAkses(token: string): Promise<IsiAkses> {
  try {
    const { payload } = await jwtVerify(token, kunci(), {
      algorithms: ["HS256"],
    });
    if (!payload.sub) throw new Error("tanpa sub");
    return { sub: payload.sub, peran: payload.peran as Peran };
  } catch {
    throw unauthorized("Sesi Anda sudah berakhir. Masuk lagi.", "SESI_HABIS");
  }
}

/* ── Refresh token ───────────────────────────────────────────────────── */

/*
 * Yang disimpan di basis data adalah SHA-256 dari refresh token, bukan
 * tokennya. Kalau tabel sesi bocor, isinya tidak bisa dipakai masuk.
 *
 * SHA-256 di sini SENGAJA, bukan argon2 seperti kata sandi: refresh token
 * adalah 256 bit acak, bukan sesuatu yang bisa ditebak dengan kamus. Memakai
 * argon2 hanya menambah ratusan milidetik pada setiap penyegaran tanpa
 * menambah keamanan sedikit pun.
 */
export const buatRefresh = () => randomBytes(32).toString("base64url");

export const hashRefresh = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/* ── Kode email 6 digit ──────────────────────────────────────────────── */

/** `randomInt`, bukan `Math.random()` — kode verifikasi harus tak tertebak. */
export const buatKodeEmail = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const hashKode = (kode: string) =>
  createHash("sha256").update(kode).digest("hex");

/**
 * Membandingkan kode dalam waktu tetap.
 *
 * Perbandingan `===` biasa berhenti di karakter pertama yang berbeda, dan
 * selisih waktunya cukup untuk menebak kode enam digit satu digit demi satu
 * digit. Ini murah; tidak ada alasan tidak memakainya.
 */
export function kodeCocok(hashTersimpan: string, kodeDikirim: string): boolean {
  const a = Buffer.from(hashTersimpan, "hex");
  const b = Buffer.from(hashKode(kodeDikirim), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
