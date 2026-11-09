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
  "postgresql://jernih:jernih@localhost:5435/jernih_test?schema=public";
process.env.JWT_SECRET ??= "kunci-uji-minimal-tiga-puluh-dua-karakter-aman";
process.env.MAIL_ENABLED = "false";
process.env.DEMO_TOKEN_ENABLED = "true";
/* Kunci enkripsi kode token. Disetel DI SINI, bukan di `beforeAll` berkas
   tesnya: `env()` membaca `process.env` sekali lalu menyimpannya, jadi
   apa pun yang disetel sesudah modul pertama memanggilnya tidak pernah
   terbaca — dan gejalanya "TOKEN_ENC_KEY belum diatur" di tes yang jelas-
   jelas sudah menyetelnya. */
process.env.TOKEN_ENC_KEY = "kunci-uji-enkripsi-kode-token-jernih";
