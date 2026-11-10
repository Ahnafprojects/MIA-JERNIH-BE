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

/*
 * Layanan notifikasi dianggap TERKONFIGURASI selama pengujian.
 *
 * Alasannya sama dengan TOKEN_ENC_KEY di atas: `NOTIFIKASI_URL` dan
 * `NOTIFIKASI_SECRET` dibaca lewat `env()`, yang membaca `process.env` SEKALI
 * lalu menyimpannya. Menyetelnya di dalam `beforeAll` sebuah tes tidak
 * pernah terbaca, dan `notifikasiAktif()` tetap `false` — sehingga setiap uji
 * tentang penyaringan opt-in akan lolos tanpa menguji apa pun, karena
 * `kabariWarga` keluar lebih awal karena alasan yang salah.
 *
 * Alamatnya sengaja menunjuk port yang tidak ada. Uji yang memang perlu
 * mengamati permintaannya mengganti `globalThis.fetch` dengan tiruan; yang
 * tidak menggantinya akan gagal menyambung, dan itu tetap aman karena
 * `kabariWarga` menelan galat jaringannya sendiri. Yang jelas tidak akan
 * terjadi: pesan WhatsApp sungguhan terkirim dari rangkaian uji.
 *
 * Dipaksa dengan `=`, BUKAN `??=`, dan itu bedanya penting. Dengan `??=`,
 * siapa pun yang kebetulan menaruh `NOTIFIKASI_URL` sungguhan di `.env`
 * miliknya membuat rangkaian uji menunjuk layanan produksi yang memegang
 * sesi WhatsApp nomor bisnis tim. Uji tidak boleh pernah mewarisi
 * konfigurasi notifikasi dari lingkungan siapa pun.
 */
process.env.NOTIFIKASI_URL = "http://127.0.0.1:59999";
process.env.NOTIFIKASI_SECRET = "rahasia-notifikasi-uji";
