/**
 * Environment untuk tes.
 *
 * `src/env.ts` sengaja gagal cepat kalau konfigurasinya kurang — itu perilaku
 * yang diinginkan di produksi. Di sini nilainya diisi dengan nilai uji supaya
 * tes tidak menuntut `.env` milik siapa pun, dan supaya tes yang lupa
 * menyetel sesuatu gagal karena alasan yang benar.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgresql://jernih:jernih@localhost:5432/jernih_test?schema=public";
process.env.JWT_SECRET ??= "kunci-uji-minimal-tiga-puluh-dua-karakter-aman";
process.env.MAIL_ENABLED = "false";
