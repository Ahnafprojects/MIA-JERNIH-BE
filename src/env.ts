/**
 * Konfigurasi dari environment, divalidasi sekali saat proses mulai.
 *
 * Gagal cepat lebih baik daripada gagal di tengah permintaan pengguna: kalau
 * DATABASE_URL salah, kita ingin tahu saat `npm run dev`, bukan saat juri
 * sedang mencoba halaman pembelian.
 */
import { z } from "zod";

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

  SEED_PASSWORD: z.string().default("admin123"),
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
