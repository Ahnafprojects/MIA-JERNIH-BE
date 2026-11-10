/**
 * Konfigurasi dari environment, divalidasi sekali saat proses mulai.
 *
 * Gagal cepat lebih baik daripada gagal di tengah permintaan pengguna: kalau
 * DATABASE_URL salah, kita ingin tahu saat `npm run dev`, bukan saat juri
 * sedang mencoba halaman pembelian.
 */
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

const bool = (bawaan: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .default(bawaan ? "true" : "false")
    .transform((v) => v === "true" || v === "1");

const skema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL wajib diisi"),

  /** Minimal 32 karakter — kunci pendek membuat JWT gampang ditebak. */
  JWT_SECRET: z.string().min(32, "JWT_SECRET minimal 32 karakter"),
  ACCESS_TTL_MENIT: z.coerce.number().int().positive().default(15),
  REFRESH_TTL_HARI: z.coerce.number().int().positive().default(30),

  /** Asal yang boleh memanggil API, dipisah koma. */
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  /**
   * Alamat depan portal, dipakai menyusun tautan di email (atur ulang sandi).
   * Sebelumnya `https://jernih.id` ditulis langsung di `rute/auth.ts`, sehingga
   * email dari staging dan lokal mengirim pengguna ke situs produksi.
   */
  APP_URL: z.string().default("http://localhost:3000"),

  /**
   * Rahasia tanda tangan webhook penyedia pembayaran.
   *
   * Sengaja TANPA nilai bawaan. Sebelumnya ada cadangan yang ditulis di kode
   * (`"jernih-webhook-secret-key-2026"`), artinya siapa pun yang membaca repo
   * bisa menandatangani webhook palsu. Kalau kosong, endpoint webhook menolak
   * semua permintaan — lebih baik pembayaran tidak terproses daripada saldo
   * bisa diisi gratis.
   */
  PAYMENT_WEBHOOK_SECRET: z.string().default(""),
  MAIL_ENABLED: bool(false),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("Jernih <noreply@jernih.id>"),

  /**
   * Mode peragaan: pembelian langsung lunas dan kode token ikut dikirim,
   * tanpa QRIS dan tanpa menunggu webhook penyedia.
   * WAJIB false kalau pembayaran sungguhan dipasang — kalau tidak, siapa pun
   * yang bisa memanggil POST /api/payment mendapat air gratis.
   */
  PAYMENT_AUTO_SETTLE: bool(true),

  /**
   * Mengizinkan penukaran token demo 1111 (+5L) dan 2222 (+10L) lewat API.
   * Di produksi harus bernilai false agar pelanggan tidak dapat menambah saldo
   * gratis tanpa transaksi.
   */
  DEMO_TOKEN_ENABLED: bool(false),

  /**
   * Kunci enkripsi kode token (AES-256-GCM).
   *
   * Dipakai `lib/kode-token.ts` supaya kode token bisa DIBACAKAN ULANG
   * kepada pemiliknya sampai dipakai — persis seperti kode pada struk token
   * listrik. Tanpa kunci ini token tetap terbit, hanya kodenya tidak bisa
   * ditampilkan lagi sesudah pembelian.
   *
   * Sengaja TIDAK wajib: menjadikannya wajib membuat server yang sudah
   * berjalan menolak start setelah pembaruan, dan menolak start berarti
   * seluruh layanan mati demi satu fitur tampilan. Panjangnya bebas — nilai
   * apa pun dilewatkan SHA-256 dulu untuk menjadi kunci 32 byte.
   */
  TOKEN_ENC_KEY: z.string().default(""),

  /**
   * Alamat dan rahasia layanan notifikasi (`services/notifikasi`).
   *
   * Keduanya boleh kosong: tanpa layanan itu backend tetap berjalan, hanya
   * kabar lewat WhatsApp dan Telegram yang dilewati. Yang TIDAK boleh adalah
   * mengisi salah satunya saja. Sebelumnya keduanya dibaca langsung dari
   * `process.env` tanpa pemeriksaan, sehingga rahasia yang lupa disalin
   * membuat setiap kabar ditolak 401 oleh layanan notifikasi dan hilang
   * diam-diam, tanpa satu pun tanda saat server dinyalakan.
   */
  NOTIFIKASI_URL: z
    .string()
    .trim()
    .default("")
    .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), {
      message: "NOTIFIKASI_URL harus berupa alamat http:// atau https://",
    })
    .transform((v) => v.replace(/\/+$/, "")),
  NOTIFIKASI_SECRET: z.string().trim().default(""),

  /**
   * Channel Telegram untuk pengumuman ke SEMUA warga, mis. `@JernihInfo`.
   *
   * Layanan notifikasi sudah menerima tujuan berbentuk `@nama`, tetapi
   * sebelumnya tidak ada yang mengirim ke sana. Channel hanya dipakai untuk
   * broadcast bertarget seluruh warga: isinya terbuka untuk siapa pun yang
   * mengikuti channel, jadi pengumuman yang hanya ditujukan ke satu zona
   * atau ke warga bersaldo rendah tidak pantas dikirim ke sana.
   */
  TELEGRAM_CHANNEL: z
    .string()
    .trim()
    .default("")
    .refine((v) => v === "" || /^(@[A-Za-z0-9_]{5,}|-100\d+)$/.test(v), {
      message: "TELEGRAM_CHANNEL harus berupa @namachannel atau id -100…",
    }),

  SEED_PASSWORD: z.string().default("admin123"),
}).superRefine((cfg, ctx) => {
  const adaUrl = cfg.NOTIFIKASI_URL !== "";
  const adaRahasia = cfg.NOTIFIKASI_SECRET !== "";
  if (adaUrl !== adaRahasia) {
    ctx.addIssue({
      code: "custom",
      path: [adaUrl ? "NOTIFIKASI_SECRET" : "NOTIFIKASI_URL"],
      message:
        "NOTIFIKASI_URL dan NOTIFIKASI_SECRET harus diisi berdua atau dikosongkan berdua.",
    });
  }
});

let tersimpan: z.infer<typeof skema> | null = null;

export function env(): z.infer<typeof skema> {
  if (tersimpan) return tersimpan;
  const hasil = skema.safeParse(process.env);
  if (!hasil.success) {
    const rincian = hasil.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Konfigurasi environment tidak sah:\n${rincian}`);
  }
  tersimpan = hasil.data;
  return tersimpan;
}

/** Dipakai tes untuk memaksa pembacaan ulang setelah mengubah process.env. */
export const resetEnv = (): void => {
  tersimpan = null;
};
