/**
 * Konfigurasi Prisma CLI (migrate, studio, seed).
 *
 * Sejak Prisma 7, URL koneksi tidak boleh lagi ditulis di `schema.prisma`.
 * Berkas ini yang menyediakannya untuk perintah CLI; PrismaClient saat
 * runtime memakai adapter di `src/lib/prisma.ts`.
 */
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { seed: "tsx prisma/seed.ts" },
  datasource: { url: env("DATABASE_URL") },
});
