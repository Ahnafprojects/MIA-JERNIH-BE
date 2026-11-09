/**
 * Penyimpanan kode token yang masih bisa DIBACAKAN ULANG kepada pemiliknya.
 *
 * ── Kenapa hash saja tidak cukup ──────────────────────────────────────
 *
 * Kode token semula hanya disimpan sebagai `kodeHash`, diperlakukan persis
 * seperti kata sandi. Itu salah kategori, dan akibatnya nyata:
 *
 *   - Warga membeli token hari ini dan baru mengisinya besok dari ponsel
 *     lain. Kodenya sudah tidak ada di mana pun kecuali email.
 *   - Isi otomatis menerbitkan token tanpa warga membuka halaman apa pun.
 *     Tidak ada satu pun peramban yang sempat memegang kodenya. Kalau
 *     emailnya gagal terkirim, token itu hilang permanen — padahal saldo
 *     sudah terpotong dan uangnya sudah masuk.
 *
 * Kata sandi di-hash JUSTRU supaya aslinya tidak bisa dibaca lagi. Kode
 * token kebalikannya: ia harus bisa ditunjukkan ulang kepada pemiliknya
 * sampai dipakai, sama seperti kode pada struk token listrik.
 *
 * ── Enkripsi, bukan plaintext ─────────────────────────────────────────
 *
 * Kode disimpan terenkripsi AES-256-GCM dengan kunci dari `TOKEN_ENC_KEY`.
 * Satu basis data yang bocor karena itu tidak langsung menjadi saldo air
 * yang bisa dipakai orang lain — penyerang masih butuh kunci yang tidak
 * pernah ikut di dalam basis data.
 *
 * GCM, bukan CBC: ia menghasilkan tag autentikasi, jadi ciphertext yang
 * diubah di basis data akan GAGAL didekripsi alih-alih menghasilkan
 * sampah yang diam-diam dianggap kode. IV acak 12 byte per kode, jadi dua
 * kode yang kebetulan sama tidak pernah menghasilkan ciphertext yang sama.
 *
 * ── `kodeHash` TETAP ADA ──────────────────────────────────────────────
 *
 * Verifikasi penukaran tetap lewat `kodeHash`, tidak diganti perbandingan
 * teks biasa. Hash itu `@unique` di skema, jadi ia sekaligus yang mencegah
 * dua token berkode sama pernah terbit — jaminan yang tidak bisa diberikan
 * kolom terenkripsi, karena IV-nya acak dan ciphertext-nya selalu berbeda.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { env } from "../env.js";

/** Panjang IV yang disarankan untuk GCM: 96 bit. */
const PANJANG_IV = 12;

/**
 * Kunci 32 byte, diturunkan dari `TOKEN_ENC_KEY`.
 *
 * Dilewatkan SHA-256 lebih dulu supaya panjang env-nya tidak perlu persis
 * 32 byte — `createCipheriv` menolak kunci dengan panjang lain, dan menuntut
 * operator menghitung byte adalah cara cepat membuat deploy gagal pada
 * waktu jalan, bukan pada waktu pasang.
 */
function kunci(): Buffer {
  const rahasia = env().TOKEN_ENC_KEY;
  if (!rahasia) {
    throw new Error(
      "TOKEN_ENC_KEY belum diatur. Kode token tidak bisa dienkripsi.",
    );
  }
  return createHash("sha256").update(rahasia).digest();
}

/**
 * Apakah penyimpanan kode aktif.
 *
 * Tanpa kunci, token tetap terbit seperti biasa — hanya kodenya yang tidak
 * bisa dibacakan ulang. Memilih gagal-diam di sini disengaja: kehilangan
 * fitur tampil-ulang jauh lebih ringan daripada menggagalkan pembayaran
 * yang uangnya sudah masuk.
 */
export function kodeBisaDisimpan(): boolean {
  return Boolean(env().TOKEN_ENC_KEY);
}

/**
 * Mengenkripsi kode token untuk disimpan.
 *
 * Bentuk hasilnya `iv.ciphertext.tag`, ketiganya base64url. Disimpan sebagai
 * satu kolom teks supaya tidak menambah tiga kolom yang harus selalu
 * bergerak bersama — dan kalau salah satunya tertinggal, dekripsinya gagal
 * terang-terangan, bukan menghasilkan kode yang salah.
 */
export function enkripsiKode(kode: string): string {
  const iv = randomBytes(PANJANG_IV);
  const cipher = createCipheriv("aes-256-gcm", kunci(), iv);
  const isi = Buffer.concat([cipher.update(kode, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    isi.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Mengembalikan kode asli, atau `null` bila tidak bisa dibaca.
 *
 * Tidak pernah melempar. Kunci yang diputar, baris yang rusak, atau kolom
 * yang diisi sebelum format ini dipakai — semuanya berarti hal yang sama
 * bagi pemanggilnya: kodenya tidak tersedia. Melempar di sini akan
 * menjatuhkan halaman riwayat hanya karena satu baris lama.
 */
export function dekripsiKode(tersimpan: string | null): string | null {
  if (!tersimpan) return null;

  try {
    const [ivB64, isiB64, tagB64] = tersimpan.split(".");
    if (!ivB64 || !isiB64 || !tagB64) return null;

    const decipher = createDecipheriv(
      "aes-256-gcm",
      kunci(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));

    const kode = Buffer.concat([
      decipher.update(Buffer.from(isiB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    /* Kode token selalu angka. Hasil dekripsi yang bukan angka berarti
       kuncinya berbeda dan tag-nya kebetulan lolos — mustahil pada GCM,
       tetapi memeriksanya lebih murah daripada mempercayainya. */
    return /^\d+$/.test(kode) ? kode : null;
  } catch {
    return null;
  }
}
