# Jernih — Backend API

API untuk platform transparansi layanan air PDAM. Warga memantau pemakaian, saldo, dan pengaduannya lewat meter air prabayar, sementara data layanan dan kinerja instansi terbuka untuk publik tanpa perlu akun.

Dibuat untuk **Web In Action — Multimedia In Action (MIA) 2026**, subtema **Public Service Tracking**.

[![Deploy](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml/badge.svg)](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml)

| | |
| --- | --- |
| API produksi | <https://api.jernih.biz.id> ([health check](https://api.jernih.biz.id/health)) |
| Alias lama | `https://be-jernih.ahnaf.cloud`, masih aktif dan menunjuk server yang sama |
| Frontend | <https://jernih.biz.id> ([repositori](https://github.com/Ahnafprojects/MIA-JERNIH-FE)) |
| Pengujian | 63 tes dalam 14 suite, seluruhnya lolos |

## Daftar isi

1. [Apa yang dikerjakan sistem ini](#apa-yang-dikerjakan-sistem-ini)
2. [Tech stack](#tech-stack)
3. [Menjalankan proyek](#menjalankan-proyek)
4. [Progres saat ini](#progres-saat-ini)
5. [Akun demo](#akun-demo)
6. [Pengujian](#pengujian)
7. [Referensi endpoint](#referensi-endpoint)
8. [Model data](#model-data)
9. [Neraca air](#neraca-air)
10. [Keamanan](#keamanan)
11. [WebSocket](#websocket)
12. [Format jawaban galat](#format-jawaban-galat)
13. [Penyebaran](#penyebaran)
14. [Pemecahan masalah](#pemecahan-masalah)
15. [Struktur direktori](#struktur-direktori)

## Apa yang dikerjakan sistem ini

Lima bagian, semuanya terhubung lewat satu basis data.

**Meter air prabayar.** Tiap pelanggan punya meter dengan saldo dalam liter. Meter mengirim telemetri pemakaian, dan backend menutup katup saat saldo habis. Representasi tampilan LCD dua baris disiapkan di sisi server, sehingga firmware ESP32 tinggal menampilkannya tanpa menghitung sendiri.

**Token air.** Saldo diisi memakai kode 10 digit yang dibangkitkan secara kriptografis. Satu kode hanya bisa ditukar sekali, dan percobaan gagal dibatasi untuk mencegah tebakan beruntun.

**Pembayaran.** Pembelian token menghasilkan invoice. Di produksi, pelunasan dikonfirmasi lewat webhook bertanda tangan HMAC. Untuk peragaan tersedia mode lunas seketika.

**Pengaduan dengan SLA.** Warga melaporkan gangguan dan menerima nomor tiket. Tiap kategori punya tenggat penanganan, dan ketepatannya dihitung dari data penanganan yang sebenarnya, termasuk yang terlambat.

**Transparansi publik.** Sepuluh endpoint terbuka tanpa login menyajikan status layanan per zona, rapor kinerja SLA, neraca air, serta data mentah yang bisa diunduh. Tidak ada data pribadi di dalamnya.

## Tech stack

| Lapisan | Pilihan | Alasan |
| --- | --- | --- |
| Runtime | Node.js 22 LTS | ESM native, masa dukungan panjang |
| Framework | Express 5 | Penanganan rute asinkron tanpa pembungkus tambahan |
| Bahasa | TypeScript 5.9 | Mode ketat, tanpa `any` |
| Basis data | PostgreSQL 17 | Relasional, tipe `Decimal` dan `Date` yang presisi |
| ORM | Prisma 7 dengan driver adapter `pg` | Migrasi terversi, klien bertipe |
| Validasi | Zod 4 | Validasi runtime untuk body, query, dan konfigurasi |
| Kata sandi | Argon2id | Rekomendasi OWASP saat ini |
| Sesi | JWT lewat `jose` | Access token 15 menit, refresh 30 hari dengan rotasi |
| Realtime | `ws` | Push telemetri dan status relay per kamar |
| Keamanan HTTP | Helmet, CORS, express-rate-limit | Header, isolasi asal, pembatasan laju |
| Pengujian | Vitest dan Supertest | Tes integrasi terhadap basis data sungguhan |

## Menjalankan proyek

### Prasyarat

- Node.js 22 atau lebih baru, periksa dengan `node -v`
- npm 10 atau lebih baru, periksa dengan `npm -v`
- Docker dan Docker Compose, atau PostgreSQL 16/17 yang dipasang langsung

### Opsi A: Docker Compose

Menjalankan basis data dan API sekaligus di dalam kontainer. Paling cepat untuk sekadar mencoba.

```bash
git clone https://github.com/Ahnafprojects/MIA-JERNIH-BE.git
cd MIA-JERNIH-BE
cp .env.example .env

docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml exec app npx prisma migrate deploy
docker compose -f docker-compose.example.yml exec app node dist/prisma/seed.js
```

API siap di `http://localhost:5300`. Periksa dengan:

```bash
curl http://localhost:5300/health
```

### Opsi B: lokal

Untuk pengembangan, karena mendukung auto-reload.

```bash
git clone https://github.com/Ahnafprojects/MIA-JERNIH-BE.git
cd MIA-JERNIH-BE
npm install
cp .env.example .env
```

Jalankan PostgreSQL. Cara tercepat memakai Docker:

```bash
docker run -d --name jernih-db -p 5432:5432 \
  -e POSTGRES_USER=jernih \
  -e POSTGRES_PASSWORD=jernih \
  -e POSTGRES_DB=jernih \
  postgres:17-alpine
```

Siapkan skema dan data peragaan, lalu nyalakan server:

```bash
npm run db:generate   # membangkitkan Prisma Client
npm run db:migrate    # menerapkan migrasi ke basis data
npm run db:seed       # mengisi data peragaan

npm run dev           # mode pengembangan dengan auto-reload
```

Server berjalan di `http://localhost:4000`. Untuk menjalankan versi produksi:

```bash
npm run build
npm start
```

### Konfigurasi

`src/env.ts` memvalidasi seluruh variabel dengan Zod dan menghentikan server saat start kalau ada yang salah. Konfigurasi yang keliru sebaiknya ketahuan pada detik pertama, bukan muncul sebagai perilaku aneh beberapa jam kemudian.

| Variabel | Bawaan | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, atau `production` |
| `PORT` | `4000` | Porta HTTP |
| `DATABASE_URL` | wajib | URL koneksi PostgreSQL |
| `JWT_SECRET` | wajib | Minimal 32 karakter |
| `ACCESS_TTL_MENIT` | `15` | Umur access token dalam menit |
| `REFRESH_TTL_HARI` | `30` | Umur refresh token dalam hari |
| `CORS_ORIGIN` | `http://localhost:3000` | Daftar asal yang diizinkan, dipisah koma |
| `APP_URL` | `http://localhost:3000` | Alamat portal, dipakai menyusun tautan di email |
| `PAYMENT_WEBHOOK_SECRET` | kosong | Rahasia HMAC untuk webhook pembayaran |
| `MAIL_ENABLED` | `false` | Mengirim email sungguhan lewat SMTP |
| `SMTP_HOST`, `SMTP_PORT` | kosong, `587` | Server SMTP |
| `SMTP_USER`, `SMTP_PASS` | kosong | Kredensial SMTP |
| `MAIL_FROM` | `Jernih <noreply@jernih.id>` | Alamat pengirim email |
| `PAYMENT_AUTO_SETTLE` | `true` | Pembelian langsung lunas tanpa menunggu webhook |
| `DEMO_TOKEN_ENABLED` | `false` | Mengizinkan token peragaan `1111` dan `2222` |
| `SEED_PASSWORD` | `admin123` | Kata sandi seluruh akun hasil seed |

Tiga variabel berbahaya kalau terbawa ke produksi:

| Variabel | Akibatnya |
| --- | --- |
| `PAYMENT_AUTO_SETTLE=true` | Siapa pun yang bisa memanggil endpoint pembelian mendapat air gratis |
| `DEMO_TOKEN_ENABLED=true` | Saldo bisa ditambah tanpa transaksi lewat kode `1111` atau `2222` |
| `PAYMENT_WEBHOOK_SECRET` kosong | Endpoint webhook menolak seluruh permintaan |

Penolakan pada kasus ketiga disengaja. Pembayaran yang tidak terproses lebih baik daripada saldo yang bisa diisi siapa saja. Nilai cadangan yang dulu ditulis langsung di kode sudah dibuang, karena siapa pun yang membaca repositori bisa memakainya untuk menandatangani webhook palsu.

Dua variabel pertama bernilai `true` di `.env.example` karena berkas itu ditujukan untuk peragaan lokal, bukan produksi.

## Progres saat ini

Backend sudah selesai dan berjalan di produksi. Seluruh endpoint yang dibutuhkan frontend tersedia dan teruji.

| Status | Bagian |
| --- | --- |
| Selesai | Autentikasi: daftar, verifikasi email, masuk, masuk dari perangkat baru, refresh, keluar, lupa dan atur ulang sandi |
| Selesai | Meter: telemetri, riwayat pemakaian, kontrol relay, klaim dan lepas meter |
| Selesai | Token air: pembangkitan CSPRNG, penukaran sekali pakai, riwayat |
| Selesai | Pembayaran: katalog paket, invoice, webhook bertanda tangan HMAC |
| Selesai | Pengaduan: penomoran anti-tabrakan, perhitungan SLA, kronologi penanganan |
| Selesai | Insiden: deteksi anomali jaringan dan penugasan teknisi |
| Selesai | Konsol staf: dasbor, pelanggan, perangkat, analitik, audit, broadcast, pengaturan, peta |
| Selesai | Endpoint publik: status layanan, lacak, kinerja, statistik, neraca air, unduhan, peta |
| Selesai | WebSocket dengan isolasi kamar dan pemeriksaan hak akses |
| Selesai | Penyebaran otomatis lewat GitHub Actions dan Cloudflare Tunnel |
| Selesai | 63 tes integrasi, `tsc` dan `eslint` bersih |
| Berjalan | Pemantauan dan pencatatan terstruktur di produksi |
| Belum | Integrasi payment gateway sungguhan, saat ini masih mode peragaan |
| Belum | Bacaan meter induk fisik, saat ini memakai data peragaan di `NeracaHarian` |

## Akun demo

Seluruh akun berikut dibuat oleh `npm run db:seed` dan langsung bisa dipakai menguji login.

| Peran | Email | Kata sandi | Akses |
| --- | --- | --- | --- |
| Warga | `warga@jernih.id` | `admin123` | Portal warga: saldo, beli dan isi token, kontrol relay, buat pengaduan |
| Operator | `operator@jernih.id` | `admin123` | Konsol: dasbor, tiket pengaduan, peta jaringan |
| Supervisor | `supervisor@jernih.id` | `admin123` | Konsol: analitik, audit, tarif, broadcast |
| Teknisi | `teknisi1@jernih.id` | `admin123` | Konsol lapangan: insiden dan inspeksi meter |
| Teknisi | `teknisi2@jernih.id` | `admin123` | Teknisi cadangan |

Seed juga membuat 120 akun pelanggan dengan meter terpasang di empat zona (Bandung Timur, Cileunyi, Cimahi, Sumedang), telemetri sembilan hari terakhir, dan neraca air 400 hari ke belakang.

### Meter untuk menguji alur klaim

25 meter terakhir sengaja dibiarkan tanpa pemilik, supaya alur "hubungkan meter" bisa diperagakan dengan akun yang baru didaftarkan dan beberapa penguji bisa mendaftar berbarengan tanpa kehabisan serial.

```
JRN-10095 … JRN-10119
```

Satu serial hanya bisa diklaim satu kali. Meter yang sudah bertuan ditolak dengan kode `METER_SUDAH_TERHUBUNG`. Jalankan ulang `npm run db:seed` untuk mengembalikan kondisinya.

## Pengujian

Tes memakai basis data terpisah di porta 5435 supaya data pengembangan tidak tersentuh.

```bash
# 1. Jalankan basis data khusus pengujian
docker compose -f docker-compose.example.yml --profile test up -d db-test

# 2. Sinkronkan skema ke basis data tersebut
DATABASE_URL="postgresql://jernih:jernih@localhost:5435/jernih_test?schema=public" npx prisma db push

# 3. Jalankan seluruh tes
npm run test
```

Tanpa langkah pertama, seluruh tes gagal dengan `DatabaseDoesNotExist`. Itu kegagalan lingkungan, bukan kegagalan kode.

Pemeriksaan kualitas lainnya:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # kompilasi ke dist/
```

## Referensi endpoint

Seluruh rute berawalan `/api`.

### Publik, tanpa login

| Endpoint | Isi |
| --- | --- |
| `GET /health` | Status kesehatan service |
| `GET /api/publik/status-layanan` | Kondisi suplai air tiap zona beserta batas wilayahnya |
| `GET /api/publik/lacak/:nomor` | Status pengaduan berdasarkan nomor tiket, tanpa data pribadi |
| `GET /api/publik/kinerja?rentang=30` | Ketepatan SLA, waktu tanggap, rincian per kategori, tren mingguan |
| `GET /api/publik/statistik?rentang=30` | Air disalurkan, air tercatat, kehilangan air, deret harian, rincian per zona |
| `GET /api/publik/neraca-air?rentang=30` | Delapan komponen kehilangan air, tolok ukur, pemakaian per orang, tren 12 bulan |
| `GET /api/publik/unduh?set=harian&format=csv` | Data mentah. `set`: `harian`, `zona`, `neraca`, `bulanan`. `format`: `csv` atau `json` |
| `GET /api/publik/panduan-lacak` | Janji waktu tiap kategori, tahapan penanganan, kanal lapor, nomor contoh |
| `GET /api/publik/riwayat-zona` | Riwayat gangguan tiap zona |
| `GET /api/publik/peta` | GeoJSON poligon zona dan rekapitulasi gangguan |

Parameter `rentang` pada `/neraca-air` dan `/unduh` hanya menerima 7, 30, atau 90. Nilai lain jatuh ke 30 tanpa menjadi galat. Rincian neraca air berasal dari audit triwulanan, sehingga menyajikannya untuk rentang tiga hari akan terbaca seolah komponennya diukur harian.

### Autentikasi dan akun

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/auth/daftar` | Registrasi warga |
| `POST /api/auth/verifikasi-email` | Verifikasi kode enam digit |
| `POST /api/auth/masuk` | Masuk dengan email dan kata sandi |
| `POST /api/auth/masuk/kode` | Masuk dari perangkat baru lewat kode email |
| `POST /api/auth/refresh` | Rotasi access token lewat cookie refresh |
| `POST /api/auth/keluar` | Mencabut sesi aktif |
| `POST /api/auth/lupa`, `POST /api/auth/atur-ulang` | Atur ulang kata sandi dengan token 32 byte |
| `GET /api/me`, `PATCH /api/me` | Profil pengguna aktif |

### Meter dan telemetri

| Endpoint | Fungsi |
| --- | --- |
| `GET /api/meter/:id` | Detail meter dan representasi tampilan LCD |
| `GET /api/meter/:id/live` | Debit terkini dan status saklar |
| `GET /api/meter/:id/pemakaian` | Deret historis pemakaian |
| `POST /api/meter/:id/relay` | Membuka atau menutup katup, dengan pemeriksaan saldo |
| `POST /api/meter/hubungkan` | Klaim meter ke akun |
| `DELETE /api/meter/:id/hubungkan` | Melepas meter dari akun |

### Token dan pembayaran

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/token/tukar` | Menukar kode token ke meter |
| `GET /api/token/riwayat` | Riwayat token pengguna |
| `GET /api/paket` | Katalog denominasi pembelian |
| `POST /api/pembayaran/buat` | Membuat invoice |
| `GET /api/pembayaran/:invoice` | Status pelunasan |
| `POST /api/pembayaran/webhook` | Webhook penyedia pembayaran |

### Pengaduan dan notifikasi

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/tiket` | Membuat laporan, penomoran `LP-YYYY-MM-XXXX` |
| `GET /api/tiket`, `GET /api/tiket/:id` | Riwayat dan kronologi penanganan |
| `GET /api/notifikasi` | Kotak masuk notifikasi |
| `PATCH /api/notifikasi/:id/baca`, `/baca-semua` | Menandai notifikasi terbaca |

### Konsol staf

Seluruhnya berawalan `/api/admin` dan menuntut peran selain warga: `dashboard`, `pelanggan`, `perangkat`, `analitik`, `audit`, `broadcast`, `pengaturan`, `peta`, `tiket`, `insiden`, dan `token/buat`.

## Model data

17 entitas, didefinisikan di `prisma/schema.prisma`. Kolom yang keputusannya tidak langsung jelas diberi komentar `///` di berkas tersebut.

| Kelompok | Model | Peran |
| --- | --- | --- |
| Identitas | `Pengguna` | Akun warga dan petugas beserta perannya |
| | `Sesi` | Refresh token, disimpan sebagai hash |
| | `KodeEmail` | Kode verifikasi dan masuk dari perangkat baru |
| Jaringan | `Zona` | Wilayah distribusi dan batas GeoJSON |
| | `NeracaHarian` | Bacaan meter induk dan meter pelanggan per zona per hari |
| | `Meter` | Meter pelanggan: saldo, relay, versi firmware, RSSI |
| | `RiwayatMeter` | Jejak perubahan kepemilikan dan konfigurasi |
| | `EmberPemakaian` | Telemetri pemakaian per jam |
| Komersial | `Golongan` | Golongan tarif dalam rupiah per liter |
| | `Token` | Token air: status, sumber, penandaan sekali pakai |
| | `Transaksi` | Invoice dan status pelunasan |
| Layanan | `Tiket` | Pengaduan warga, nomor tiket, tenggat SLA |
| | `Insiden` | Anomali jaringan seperti kebocoran |
| Operasional | `Notifikasi` | Kotak masuk pengguna |
| | `Broadcast` | Siaran pengumuman |
| | `AuditLog` | Jejak tindakan petugas |
| | `Pengaturan` | Konfigurasi tarif dan sistem |

## Neraca air

Bagian ini menjelaskan satu keputusan rancangan yang tidak terbaca dari kode.

Air tak berekening (*non-revenue water*, NRW) adalah selisih antara air yang keluar dari instalasi dan air yang terbaca di meter pelanggan. Tabel `EmberPemakaian` hanya mengenal sisi pelanggan, sehingga angka pertama tidak tersedia. Selama itu `/statistik` mengirim `nrwPct: null`, dan ubin "Kehilangan air" di halaman depan menampilkan tanda hubung.

Model `NeracaHarian` menutup kekurangan tersebut pada sumbernya. Satu baris per zona per hari, berisi dua kolom:

| Kolom | Artinya |
| --- | --- |
| `volumeIndukL` | Air yang keluar dari instalasi, dibaca meter induk zona |
| `volumeTercatatL` | Air yang terbaca di meter pelanggan |

Tiga hal yang dijaga di atas tabel ini.

**Satu sumber hitungan.** `src/lib/neraca.ts` melayani `/statistik`, `/neraca-air`, dan `/unduh` sekaligus. Kalau ketiganya menghitung sendiri, angkanya akan berselisih begitu rentang waktu diganti. Pengujian memastikan `/statistik` dan `/neraca-air` mengirim angka yang sama pada rentang yang sama, dan isi berkas unduhan menjumlah kembali ke angka yang tampil di layar.

**Rincian membagi habis.** Delapan komponen kerangka IWA dibagi memakai metode sisa terbesar. Pembulatan biasa pada delapan baris meleset beberapa meter kubik, dan baris jumlah akan berbeda dari angka besar di atasnya.

**Status datanya diakui terbuka.** Isi tabel adalah data peragaan yang dibangkitkan dari benih tetap di `prisma/neraca-demo.ts`, karena jaringan ini belum memiliki meter induk fisik. Yang bukan peragaan adalah tempatnya: data tersimpan di basis data, dan API memperlakukannya sama seperti data sungguhan. Mengganti sumbernya nanti cukup dengan mengisi tabel yang sama dari bacaan sebenarnya, tanpa mengubah satu baris pun kode endpoint.

Produksi harian diturunkan dari jumlah sambungan, bukan dipatok. Versi pertama memakai 1180 m³ per hari, angka yang masuk akal untuk sebuah kota. Basis data peragaan ini berisi 120 sambungan, sehingga halaman melaporkan 2.028 liter per orang per hari dengan pemenuhan kebutuhan dasar 3.381%. Setelah diperbaiki, angkanya sekitar 161 liter per orang per hari.

## Keamanan

Daftar berikut mencatat apa yang ditegakkan dan teruji.

**Kata sandi dan sesi.** Argon2id untuk kata sandi. Access token berumur 15 menit. Refresh token berumur 30 hari dan disimpan sebagai hash, sehingga bocornya basis data tidak langsung berarti sesi dapat dibajak. Rotasi dilakukan pada setiap pemanggilan `/refresh`.

**Pembatasan percobaan.** Kode email dan penukaran token dibatasi lima percobaan, di samping rate limit per alamat IP. Rate limit saja tidak cukup, karena penyerang dengan banyak alamat IP tetap bisa menebak kode enam digit sampai tembus kalau kodenya sendiri tidak pernah terkunci.

**Webhook pembayaran.** Tanda tangan HMAC-SHA256 bersifat wajib. Bentuk tanda tangan diperiksa dengan `/^[0-9a-f]{64}$/i` sebelum `timingSafeEqual`, karena fungsi tersebut melempar saat panjang kedua penyangga berbeda, dan lemparan itu sendiri membocorkan informasi.

**Kode verifikasi tidak masuk log.** `subjekAman()` menyamarkan deret empat angka atau lebih sebelum subjek email ditulis ke log. Kode yang tercatat di log dapat dibaca siapa pun yang punya akses ke log tersebut.

**Kepemilikan diperiksa terpusat.** Seluruh rute meter melewati `pastikanAksesMeter()`. Warga hanya dapat menyentuh meter miliknya, sedangkan petugas dapat melihat seluruhnya.

**Kamar WebSocket menolak secara bawaan.** Prefix yang tidak dikenal diabaikan. Versi sebelumnya menerima apa pun selain `meter:` dan `admin:`, sehingga prefix baru yang ditambahkan kemudian otomatis terbuka untuk warga, dan nama kamar sembarang dari query string dapat membuat peta kamar tumbuh tanpa batas. Jumlah kamar dibatasi 20 per koneksi.

**Endpoint publik tanpa data pribadi.** Tidak ada nama, alamat, kontak, nomor sambungan, maupun koordinat rumah di `/api/publik/*` mana pun, termasuk `/peta` yang hanya mengirim poligon zona.

## WebSocket

```
ws://<host>/ws?token=<accessToken>&rooms=meter:P001,admin:dashboard
```

Kamar ditentukan di query string saat menyambung, bukan lewat pesan berlangganan. Tidak ada protokol `subscribe` setelah koneksi terbuka. Untuk memantau meter lain, sambung ulang dengan nilai `rooms` yang berbeda.

Server mengirim satu bingkai pembuka begitu koneksi diterima:

```json
{
  "event": "hello",
  "data": { "penggunaId": "...", "peran": "WARGA", "rooms": ["meter:P001"] },
  "ts": 1761868800000
}
```

Bingkai berikutnya memakai bentuk yang sama, yaitu `{ event, data, ts }`:

| `event` | Kamar | Isi |
| --- | --- | --- |
| `meter:status` | `meter:<id>` | Debit, saldo, status daring |
| `meter:saldo` | `meter:<id>` | Perubahan saldo |
| `meter:relay` | `meter:<id>` | Katup terbuka atau tertutup |
| `dashboard` | `admin:dashboard` | Ringkasan operasional untuk konsol |

Hak akses diperiksa saat upgrade koneksi, bukan saat pengiriman:

- `meter:<id>` terbuka untuk warga pemilik meter tersebut, dan untuk seluruh petugas.
- `admin:*` hanya untuk peran selain warga.
- Prefix lain diabaikan.

Server mengirim `ping` setiap 30 detik. Klien yang tidak membalas `pong` akan diputus.

## Format jawaban galat

Seluruh galat memakai bentuk yang sama, dengan pesan berbahasa Indonesia yang siap ditampilkan di antarmuka.

```json
{
  "error": {
    "code": "KREDENSIAL_SALAH",
    "message": "Email atau kata sandi salah."
  }
}
```

Galat validasi menyertakan rincian per medan:

```json
{
  "error": {
    "code": "VALIDASI_GAGAL",
    "message": "Data yang dikirim tidak memenuhi syarat.",
    "issues": [
      { "field": "kataSandi", "message": "Kata sandi minimal 8 karakter." }
    ]
  }
}
```

Nilai `code` bersifat stabil dan boleh dicocokkan di frontend. Nilai `message` dapat berubah sewaktu-waktu dan tidak boleh dipakai sebagai penanda logika.

| Kelompok | Kode |
| --- | --- |
| Umum | `VALIDASI_GAGAL`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMIT`, `TERLALU_SERING`, `INTERNAL` |
| Sesi | `KREDENSIAL_SALAH`, `SESI_HABIS`, `SESI_DICABUT`, `SESI_TIDAK_VALID`, `AKUN_NONAKTIF`, `EMAIL_TERDAFTAR`, `EMAIL_BELUM_VERIFIKASI`, `PENGGUNA_TIDAK_DITEMUKAN` |
| Kode email | `KODE_SALAH`, `KODE_KEDALUWARSA`, `KODE_SUDAH_DIPAKAI`, `KODE_TERKUNCI`, `KODE_TIDAK_DITEMUKAN`, `PERCOBAAN_TERKUNCI` |
| Meter | `BUKAN_PEMILIK_METER`, `METER_SUDAH_TERHUBUNG`, `METER_TIDAK_COCOK`, `SALDO_HABIS`, `SAKLAR_OFF` |
| Token air | `TOKEN_INVALID`, `TOKEN_SUDAH_DIPAKAI`, `TOKEN_KEDALUWARSA`, `TOKEN_DIBATALKAN`, `TOKEN_TIDAK_ADA` |
| Pembayaran | `SIGNATURE_WAJIB`, `SIGNATURE_INVALID`, `INVOICE_WAJIB`, `BUKAN_PEMILIK_TRANSAKSI`, `BUKAN_PEMILIK_TAGIHAN` |
| Unduhan publik | `SET_TIDAK_DIKENAL`, `FORMAT_TIDAK_DIDUKUNG` |

## Penyebaran

Push ke `main` memicu `.github/workflows/deploy.yml`. Alurnya: SSH lewat Cloudflare Tunnel, `git reset --hard origin/main`, `docker compose up -d --build`, lalu dua perintah di dalam kontainer.

```bash
docker compose exec -T app sh -c "npx prisma migrate deploy" < /dev/null
docker compose exec -T app sh -c "node dist/prisma/isi-neraca.js" < /dev/null
```

Tiga detail yang mahal dipelajari.

**`< /dev/null` wajib pada setiap baris `exec`.** Badan skrip dikirim ke server lewat stdin ssh. `docker compose exec -T` mewarisi stdin yang sama dan menelan sisa skrip sebagai masukan untuk perintah di dalam kontainer. Selama hanya ada satu baris `exec` dan ia yang terakhir, tidak ada yang hilang. Begitu baris kedua ditambahkan, baris itu tidak pernah dijalankan. Yang berbahaya, tidak ada yang gagal: `set -e` tidak melihat galat, log berhenti sesudah migrasi, dan job tetap hijau. Satu-satunya tanda adalah tabel yang kosong di produksi.

**`node dist/...`, bukan `npx tsx`.** Image produksi menjalankan `npm prune --omit=dev`, sehingga `tsx` tidak tersedia di sana. Direktori `prisma` termasuk dalam `tsconfig.json`, jadi `npm run build` sudah memancarkan `dist/prisma/isi-neraca.js`.

**`isi-neraca.ts`, bukan `seed.ts`.** Seed mengosongkan seluruh tabel terlebih dahulu dan akan menghapus akun, tiket, serta transaksi yang sudah ada. Skrip pengisi hanya menulis kalau `NeracaHarian` masih kosong, dan berhenti tanpa menyentuh apa pun kalau sudah terisi.

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

## Struktur direktori

```text
MIA-JERNIH-BE/
├── .github/workflows/
│   └── deploy.yml              CI/CD lewat GitHub Actions
├── prisma/
│   ├── migrations/             Migrasi PostgreSQL terversi
│   ├── schema.prisma           17 model entitas
│   ├── neraca-demo.ts          Pembangkit bacaan meter induk
│   ├── isi-neraca.ts           Pengisi NeracaHarian di server
│   └── seed.ts                 Data peragaan lengkap
├── src/
│   ├── lib/
│   │   ├── neraca.ts           Sumber tunggal hitungan neraca air
│   │   ├── unduh.ts            Kumpulan data dan penulis CSV/JSON
│   │   └── …                   auth, prisma, email, errors, logger
│   ├── middleware/             Verifikasi sesi, guard peran, rate limiter
│   ├── rute/
│   │   ├── auth.ts             Registrasi, masuk, verifikasi, atur ulang sandi
│   │   ├── bayar.ts            Paket, invoice, webhook
│   │   ├── geo.ts              GeoJSON untuk konsol
│   │   ├── insiden.ts          Deteksi anomali jaringan
│   │   ├── konsol.ts           Dasbor, pelanggan, perangkat, audit, pengaturan
│   │   ├── meter.ts            Telemetri, kontrol relay, tampilan LCD
│   │   ├── notifikasi.ts       Kotak masuk pengguna
│   │   ├── publik.ts           Endpoint transparansi tanpa login
│   │   ├── tiket.ts            Pengaduan dan kalkulasi SLA
│   │   └── token.ts            Validasi dan penukaran token
│   ├── app.ts                  Perakitan Express dan error handler
│   ├── env.ts                  Validasi konfigurasi, gagal saat start
│   ├── server.ts               Entrypoint HTTP dan graceful shutdown
│   └── ws.ts                   Manajer WebSocket dan broadcast kamar
├── tests/                      14 suite tes integrasi
├── Dockerfile                  Build multi-stage
├── docker-compose.example.yml  Compose untuk pengembangan dan basis data uji
└── tsconfig.json
```

## Tim

Dikembangkan untuk Web In Action — Multimedia In Action 2026 oleh Tim Jernih.
