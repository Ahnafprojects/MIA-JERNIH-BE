/**
 * Konfigurasi Prisma CLI (migrate, studio, seed).
 *
 * Sejak Prisma 7, URL koneksi tidak boleh lagi ditulis di `schema.prisma`.
 * Berkas ini yang menyediakannya untuk perintah CLI; PrismaClient saat
 * runtime memakai adapter di `src/lib/prisma.ts`.
 */
try {
  await import("dotenv/config");
} catch {
  // Abaikan bila dotenv tidak terpasang (misal di production runner)
}
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { seed: "node dist/prisma/seed.js" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
