# Catatan teknis

Berkas ini untuk orang yang menyentuh kodenya, bukan untuk pembaca umum.
Isinya gejala-gejala yang pernah benar-benar terjadi di proyek ini, lengkap
dengan sebab yang tidak kelihatan dari pesan galatnya.

Dipisahkan dari README supaya halaman depan repositori menjawab pertanyaan
yang dibawa pembaca baru — apa ini, bagaimana menjalankannya, sudah sampai
mana — tanpa tertimbun catatan kerja.

## Pemecahan masalah

**Seluruh tes gagal dengan `DatabaseDoesNotExist`.** Basis data pengujian di porta 5435 belum berjalan. Jalankan langkah pertama pada bagian [Pengujian](#pengujian).

**Halaman frontend menampilkan rangka pemuatan terus-menerus tanpa pesan galat.** Hampir selalu CORS. Asal yang dipakai peramban tidak terdaftar di `CORS_ORIGIN`. Perhatikan bahwa `http://localhost:3000` dan `http://127.0.0.1:3000` adalah asal yang berbeda, dan pengalihan dari apex ke `www` mengubah header `Origin` yang sampai ke server. Periksa dengan:

```bash
curl -s -D- -o /dev/null -H "Origin: http://localhost:3000" \
  http://localhost:4000/api/publik/statistik | grep -i access-control
```

Tidak adanya baris `Access-Control-Allow-Origin` berarti asal tersebut ditolak.

**Kehilangan air terbaca 0% alih-alih tanda hubung.** Tabel `NeracaHarian` kosong. Jalankan `node dist/prisma/isi-neraca.js` di server, atau `npm run db:seed` di lokal.

**Penyebaran hijau tetapi perubahan tidak terlihat di server.** Periksa apakah ada `docker compose exec -T` tanpa `< /dev/null` di `deploy.yml`.

**Webhook pembayaran membalas 400 untuk permintaan yang tampak benar.** `PAYMENT_WEBHOOK_SECRET` kosong. Perilaku ini disengaja.

**Email tidak terkirim saat pengembangan.** `MAIL_ENABLED=false` adalah nilai bawaan. Kode verifikasi tetap dibuat dan tersimpan di tabel `KodeEmail`.

**Prisma mengeluh klien tidak cocok dengan skema.** Jalankan `npm run db:generate` setelah setiap perubahan pada `schema.prisma`.
