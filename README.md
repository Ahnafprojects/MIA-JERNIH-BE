# Jernih — Backend API

> **Platform Transparansi Layanan Air Bersih PDAM Terintegrasi Smart Metering & Pelacakan Publik**  
> Dibuat untuk **Web In Action — Multimedia In Action (MIA) 2026**, Subtema: **Public Service Tracking**.

- **URL API Live:** [https://api.jernih.biz.id](https://api.jernih.biz.id) — ini yang dipanggil frontend. Health check: [`/health`](https://api.jernih.biz.id/health)
- **Alias lama:** `https://be-jernih.ahnaf.cloud` (masih hidup, menunjuk server yang sama)
- **URL Frontend Live:** [https://jernih.biz.id](https://jernih.biz.id) ([Repositori Frontend](https://github.com/Ahnafprojects/MIA-JERNIH-FE))
- **Status CI/CD:** [![Deploy](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml/badge.svg)](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml) (GitHub Actions via Cloudflare Tunnel)
- **Status Pengujian:** 63/63 lolos (14 suite Vitest)

---

## 🌊 Ringkasan Proyek

Jernih adalah sistem backend modern untuk transparansi tata kelola air PDAM pintar. Menghubungkan telemetri meter air prabayar/pascabayar, token digital 10-digit berstandar CSPRNG, pelaporan pengaduan warga dengan kalkulasi SLA real-time, deteksi otomatis insiden kebocoran pipa, serta **endpoint transparansi publik tanpa login** yang menjamin akuntabilitas data instansi kepada masyarakat luas.

### Fitur Unggulan Arsitektur:
1. **Endpoint Publik Terbuka & Aman:** Menampilkan status layanan zona, rapor kinerja SLA aktual (30 hari), dan statistik volume air tanpa login, dengan isolasi privasi ketat (koordinat rumah warga tidak pernah diekspos).
2. **Kepatuhan Smart Metering:** Format LCD 2-baris sesuai spesifikasi firmware ESP32, perlindungan relay magnetik (*fail-closed* saat saldo habis), dan pelacakan telemetri.
3. **Generator & Penukaran Token CSPRNG:** Token 10 digit kriptografis acak, pencegahan pemakaian ulang (*single-use*), pembatasan percobaan gagal (*anti brute-force* 5x jeda 10 menit).
4. **Alur Pembayaran & Mode Lunas-Seketika:** Mendukung simulasi pembayaran instan untuk peragaan demo (`PAYMENT_AUTO_SETTLE=true`) maupun verifikasi tanda tangan kriptografis webhook HMAC-SHA256 yang aman di produksi.
5. **Realtime WebSocket Event:** Komunikasi dua arah untuk push status relay, saldo meter air pelanggan, dan siaran analitik dasbor operator.

---

## 🛠️ Tech Stack

| Lapisan | Teknologi | Kegunaan |
| --- | --- | --- |
| **Runtime** | Node.js 22 (LTS) | Eksekusi JavaScript/TypeScript performa tinggi (ESM native) |
| **Framework** | Express 5 | Web framework generasi terbaru dengan penanganan rute asinkron native |
| **Bahasa** | TypeScript 5.9 | Type-safety penuh end-to-end |
| **Database & ORM** | PostgreSQL 17 + Prisma 7 | RDBMS relasional dengan Prisma Client & PG Driver Adapter |
| **Validasi Skema** | Zod 4 | Validasi runtime ketat pada body, query, dan konfigurasi environment |
| **Hashing Sandi** | Argon2id | Kriptografi kata sandi modern standar OWASP |
| **Sesi & Token** | JWT (`jose`) | Access token (15 menit) + Refresh token rotasi SHA-256 (30 hari) |
| **Protokol Realtime** | WebSocket (`ws`) | Push telemetri, kontrol saklar/relay, dan notifikasi kamar |
| **Keamanan HTTP** | Helmet, CORS, Rate-Limit | Proteksi header, isolasi origin, pembatasan laju permintaan |
| **Testing** | Vitest + Supertest | Unit testing, integration testing, dan verifikasi otomatis |

---

## 📋 Prasyarat Sistem

Sebelum menjalankan proyek, pastikan perangkat Anda telah terpasang:
- **Node.js** versi `22.x` atau lebih baru (`node -v`)
- **npm** versi `10.x` atau lebih baru (`npm -v`)
- **Docker & Docker Compose** (Sangat disarankan untuk database PostgreSQL instan) atau PostgreSQL lokal versi 16/17

---

## 🚀 Panduan Instalasi & Menjalankan

Penguji atau pengembang dapat memilih salah satu dari dua metode di bawah ini:

### Opsi A. Menjalankan Penuh via Docker Compose (Metode Paling Cepat)

Metode ini menjalankan seluruh sistem (Database PostgreSQL + Backend API) dalam kontainer terisolasi:

```bash
# 1. Clone repositori
git clone https://github.com/Ahnafprojects/MIA-JERNIH-BE.git
cd MIA-JERNIH-BE

# 2. Siapkan file konfigurasi environment
cp .env.example .env

# 3. Jalankan service menggunakan Docker Compose
docker compose -f docker-compose.example.yml up -d --build

# 4. Terapkan migrasi database dan masukkan data demo ke dalam kontainer
docker compose -f docker-compose.example.yml exec app npx prisma migrate deploy
docker compose -f docker-compose.example.yml exec app node dist/prisma/seed.js
```

API backend siap diakses pada `http://localhost:5300`. Uji melalui peramban atau terminal:
```bash
curl http://localhost:5300/health
```

---

### Opsi B. Menjalankan di Lingkungan Lokal (Manual / Development)

Langkah detail instalasi native untuk pengembangan dan pengujian lokal:

#### 1. Clone Repositori & Install Dependensi
```bash
git clone https://github.com/Ahnafprojects/MIA-JERNIH-BE.git
cd MIA-JERNIH-BE
npm install
```

#### 2. Konfigurasi Environment (`.env`)
Salin berkas contoh:
```bash
cp .env.example .env
```
Isi konfigurasi pada file `.env` (nilai bawaan sudah disesuaikan untuk lingkungan lokal):
```ini
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://jernih:jernih@localhost:5432/jernih?schema=public"
JWT_SECRET="kunci-rahasia-minimal-tiga-puluh-dua-karakter-harus-aman"
CORS_ORIGIN="http://localhost:3000,https://jernih.biz.id"
APP_URL="http://localhost:3000"
PAYMENT_AUTO_SETTLE=true
DEMO_TOKEN_ENABLED=true
SEED_PASSWORD=admin123
```

`src/env.ts` memvalidasi seluruhnya dengan Zod dan **gagal saat start** kalau
ada yang salah. Itu disengaja: konfigurasi yang keliru harus menjatuhkan
server pada detik pertama, bukan muncul sebagai perilaku aneh tiga jam
kemudian.

| Variabel | Bawaan | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `4000` | Porta HTTP |
| `DATABASE_URL` | — | **Wajib.** URL PostgreSQL |
| `JWT_SECRET` | — | **Wajib, minimal 32 karakter.** Kunci tanda tangan access token |
| `ACCESS_TTL_MENIT` | `15` | Umur access token |
| `REFRESH_TTL_HARI` | `30` | Umur refresh token |
| `CORS_ORIGIN` | `http://localhost:3000` | Asal yang boleh memanggil, dipisah koma |
| `APP_URL` | `http://localhost:3000` | Alamat portal; dipakai menyusun tautan di email |
| `PAYMENT_WEBHOOK_SECRET` | *(kosong)* | Rahasia HMAC webhook pembayaran |
| `MAIL_ENABLED` | `false` | Kirim email sungguhan lewat SMTP |
| `SMTP_HOST` / `SMTP_PORT` | — / `587` | Server SMTP |
| `SMTP_USER` / `SMTP_PASS` | — | Kredensial SMTP |
| `MAIL_FROM` | `Jernih <noreply@jernih.id>` | Pengirim email |
| `PAYMENT_AUTO_SETTLE` | `true` | Pembelian langsung lunas tanpa menunggu webhook |
| `DEMO_TOKEN_ENABLED` | `false` | Mengizinkan token peragaan `1111` (+5 L) dan `2222` (+10 L) |
| `SEED_PASSWORD` | `admin123` | Kata sandi seluruh akun hasil seed |

### ⚠️ Tiga variabel yang berbahaya di produksi

| Variabel | Kenapa berbahaya |
| --- | --- |
| `PAYMENT_AUTO_SETTLE=true` | Siapa pun yang bisa memanggil `POST /api/pembayaran/buat` mendapat air **gratis**. Wajib `false` begitu pembayaran sungguhan dipasang. |
| `DEMO_TOKEN_ENABLED=true` | Saldo bisa ditambah tanpa transaksi lewat kode `1111`/`2222`. |
| `PAYMENT_WEBHOOK_SECRET` kosong | Endpoint webhook **menolak semua permintaan**. Itu memang pilihan yang diambil: lebih baik pembayaran tidak terproses daripada saldo bisa diisi siapa saja. Nilai cadangan yang pernah ditulis di kode sudah dibuang — siapa pun yang membaca repo bisa menandatangani webhook palsu dengannya. |

Keduanya yang pertama bernilai `true` di `.env.example` **karena berkas itu
untuk peragaan lokal**, bukan untuk produksi.

#### 3. Jalankan Database PostgreSQL
Gunakan Docker untuk menjalankan PostgreSQL instan:
```bash
docker run -d --name jernih-db -p 5432:5432 \
  -e POSTGRES_USER=jernih \
  -e POSTGRES_PASSWORD=jernih \
  -e POSTGRES_DB=jernih \
  postgres:17-alpine
```

#### 4. Migrasi Skema & Seeding Data
Generate client Prisma, terapkan migrasi tabel, dan isi data demo komprehensif:
```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

#### 5. Jalankan Server API
Jalankan mode pengembangan dengan auto-reload:
```bash
npm run dev
```
Atau kompilasi ke JavaScript dan jalankan mode produksi:
```bash
npm run build
npm start
```

Server akan aktif di `http://localhost:4000` (atau sesuai `PORT` di `.env`).

---

## 🔑 Akun Demo Siap Pakai (Hasil Seed Database)

Semua akun di bawah ini telah disemai secara otomatis dan siap digunakan untuk pengujian login:

| Peran (Role) | Email | Kata Sandi | Deskripsi Hak Akses |
| --- | --- | --- | --- |
| **WARGA** | `warga@jernih.id` | `admin123` | Portal warga: cek saldo meter, beli & isi token air, kontrol relay, buat pengaduan |
| **OPERATOR** | `operator@jernih.id` | `admin123` | Konsol staf: pantau dasbor operasional, proses tiket pengaduan, lihat peta jaringan |
| **SUPERVISOR** | `supervisor@jernih.id` | `admin123` | Konsol manajerial: analitik kinerja, audit log, konfigurasi tarif, siaran broadcast |
| **TEKNISI** | `teknisi1@jernih.id` | `admin123` | Konsol lapangan: tangani penugasan insiden pipa bocor & inspeksi meter warga |
| **TEKNISI** | `teknisi2@jernih.id` | `admin123` | Teknisi lapangan cadangan |

> **Catatan:** Selain akun demo di atas, seed menyertakan **120 akun pelanggan warga** dengan meter air terpasang di 4 zona (Bandung Timur, Cileunyi, Cimahi, Sumedang) lengkap dengan data historis pemakaian 9 hari terakhir.

### Meter yang bisa dihubungkan (untuk menguji onboarding)

**25 meter terakhir** sengaja dibiarkan **tanpa pemilik**, supaya alur
"hubungkan meter" bisa diperagakan dengan akun yang baru didaftarkan — dan
supaya beberapa penguji bisa mendaftar berbarengan tanpa kehabisan:

```
JRN-10095  …  JRN-10119      (25 serial berurutan)
```

Daftar akun lalu masukkan salah satu serial di layar **Hubungkan Meter**. Satu
serial hanya bisa diklaim satu kali — meter yang sudah bertuan akan ditolak
dengan `METER_SUDAH_TERHUBUNG`. Jalankan `npm run db:seed` lagi untuk
mengembalikan kelimanya.

---

## 🧪 Menjalankan Pengujian Otomatis (Test Suite)

Repositori ini dilengkapi rangkaian tes otomatis yang menguji fungsionalitas, keamanan, dan integritas data (**63 tes** dalam 14 suite).

> Sebagian tes membutuhkan basis data; tanpa kontainer di langkah 1 seluruhnya gagal dengan `DatabaseDoesNotExist`, dan itu kegagalan lingkungan, bukan kode.

Tes dirancang mandiri menggunakan database pengujian terpisah pada **port 5435** agar tidak merusak data pengembangan lokal Anda.

```bash
# 1. Jalankan container database khusus pengujian
docker compose -f docker-compose.example.yml --profile test up -d db-test

# 2. Sinkronkan skema ke database tes
DATABASE_URL="postgresql://jernih:jernih@localhost:5435/jernih_test?schema=public" npx prisma db push

# 3. Jalankan suite pengujian Vitest
npm run test
```

Perintah pengecekan kualitas kode tambahan:
```bash
npm run typecheck    # Memeriksa validitas type TypeScript (tsc --noEmit)
npm run lint         # Memeriksa standar kode dengan ESLint
npm run build        # Memverifikasi kompilasi build produksi ke dist/
```

---

## 🗺️ Ringkasan Endpoint API

Semua rute beralamat dasar `/api` dengan pembagian modul berikut:

### 1. Endpoint Publik (Transparansi Layanan — Tanpa Perlu Login)
- `GET /health` — Status kesehatan service backend
- `GET /api/publik/status-layanan` — Kondisi suplai air per zona (normal / gangguan / perbaikan)
- `GET /api/publik/lacak/:nomor` — Lacak status pengaduan warga berdasarkan nomor tiket (tanpa PII)
- `GET /api/publik/kinerja` — Rapor metrik SLA 30 hari, waktu tanggap, dan tren ketepatan
- `GET /api/publik/statistik?rentang=30` — Air disalurkan, air tercatat, kehilangan air (NRW), deret harian, dan rincian per zona
- `GET /api/publik/neraca-air?rentang=30` — Neraca air lengkap: delapan komponen kehilangan (kerangka IWA), tolok ukur, pemakaian per orang, dan tren 12 bulan
- `GET /api/publik/unduh?set=harian&format=csv&rentang=30` — Data mentah. `set`: `harian`, `zona`, `neraca`, `bulanan`. `format`: `csv`, `json`
- `GET /api/publik/panduan-lacak` — Janji waktu tiap kategori, tahapan penanganan, kanal lapor, dan nomor contoh
- `GET /api/publik/riwayat-zona` — Riwayat gangguan per zona
- `GET /api/publik/peta` — GeoJSON poligon batas zona dan rekapitulasi gangguan wilayah

> `rentang` pada `/neraca-air` dan `/unduh` hanya menerima **7, 30, atau 90**; nilai lain jatuh ke 30 — bukan menjadi galat. Rincian neraca air berasal dari audit triwulanan, dan menyajikannya untuk rentang 3 hari akan terbaca seolah komponennya diukur harian.

### 2. Autentikasi & Akun
- `POST /api/auth/daftar` — Registrasi akun warga baru
- `POST /api/auth/verifikasi-email` — Verifikasi kode OTP 6 digit email
- `POST /api/auth/masuk` — Login dengan email & kata sandi (argon2id)
- `POST /api/auth/masuk/kode` — Login perangkat baru dengan verifikasi kode
- `POST /api/auth/refresh` — Rotasi token akses via cookie refresh token aman
- `POST /api/auth/keluar` — Pencabutan sesi aktif
- `POST /api/auth/lupa` & `POST /api/auth/atur-ulang` — Alur reset sandi dengan token acak 32-byte
- `GET /api/me` & `PATCH /api/me` — Profil pengguna aktif

### 3. Smart Meter & Telemetri
- `GET /api/meter/:id` — Detail meter & representasi format tampilan LCD firmware
- `GET /api/meter/:id/live` — Nilai debit air real-time (L/menit) dan status saklar fisik
- `GET /api/meter/:id/pemakaian` — Grafik historis pemakaian air
- `POST /api/meter/:id/relay` — Kontrol buka/tutup valve relay (dilengkapi validasi saldo > 0)
- `POST /api/meter/hubungkan` — Klaim meter air pelanggan (dengan rate limiting & audit log)
- `DELETE /api/meter/:id/hubungkan` — Lepas meter air dari akun

### 4. Token Air Digital & Pembayaran
- `POST /api/token/tukar` — Penukaran kode token ke meter air (anti brute-force)
- `GET /api/token/riwayat` — Daftar riwayat token air pengguna
- `GET /api/paket` — Katalog denominasi pembelian token air
- `POST /api/pembayaran/buat` — Buat invoice transaksi air
- `GET /api/pembayaran/:invoice` — Cek status pelunasan transaksi
- `POST /api/pembayaran/webhook` — Endpoint webhook payment gateway (HMAC timing-safe)

### 5. Pengaduan Warga (Tiket SLA) & Notifikasi
- `POST /api/tiket` — Pembuatan laporan gangguan (penomoran otomatis anti tabrakan `LP-YYYY-MM-XXXX`)
- `GET /api/tiket` & `GET /api/tiket/:id` — Riwayat status pengaduan & kronologi penanganan
- `GET /api/notifikasi` — Inbox notifikasi sistem
- `PATCH /api/notifikasi/:id/baca` & `/baca-semua` — Tandai notifikasi terbaca

### 6. Konsol Staf & Admin (`/api/admin`)
- `GET /api/admin/dashboard` — Ringkasan metrik operasional seluruh instalasi PDAM
- `GET /api/admin/pelanggan` — Manajemen basis data pelanggan warga
- `GET /api/admin/perangkat` — Manajemen status daring, versi firmware, dan kondisi meter
- `GET /api/admin/analitik` — Data tren analitik konsumsi air rentang waktu dinamis
- `GET /api/admin/audit` — Log jejak rekam audit aktivitas sistem dan kendali perangkat
- `POST /api/admin/broadcast` — Pengiriman siaran pengumuman ke seluruh pelanggan
- `GET /api/admin/pengaturan` & `PUT /api/admin/pengaturan` — Konfigurasi tarif dan sistem
- `GET /api/admin/peta` — GeoJSON titik koordinat spasial meter untuk monitoring teknisi
- `GET /api/admin/tiket` & `PATCH /api/admin/tiket/:id` — Manajemen tiket dan eskalasi SLA
- `GET /api/admin/insiden` & `PATCH /api/admin/insiden/:id` — Manajemen insiden anomali pipa
- `POST /api/admin/token/buat` — Penerbitan token darurat oleh supervisor

### 7. Realtime WebSocket

```
ws://<host>/ws?token=<accessToken>&rooms=meter:P001,admin:dashboard
```

**Kamar ditentukan di query string saat menyambung, bukan lewat pesan
`subscribe`.** Tidak ada protokol berlangganan setelah koneksi terbuka —
kalau ingin memantau meter lain, sambung ulang dengan `rooms` yang berbeda.

Begitu tersambung, server mengirim satu bingkai pembuka:

```json
{ "event": "hello", "data": { "penggunaId": "...", "peran": "WARGA", "rooms": ["meter:P001"] }, "ts": 1761868800000 }
```

Seluruh bingkai berikutnya memakai bentuk yang sama — `{ event, data, ts }`:

| `event` | Kamar | Isi |
| --- | --- | --- |
| `meter:status` | `meter:<id>` | Debit, saldo, status daring |
| `meter:saldo` | `meter:<id>` | Saldo berubah (token ditukar, air terpakai) |
| `meter:relay` | `meter:<id>` | Saklar/valve terbuka atau tertutup |
| `dashboard` | `admin:dashboard` | Ringkasan operasional untuk konsol petugas |

**Hak akses kamar ditegakkan saat upgrade**, bukan saat kirim:

- `meter:<id>` — warga hanya untuk meter miliknya; petugas untuk meter mana pun.
- `admin:<apa pun>` — hanya peran non-WARGA.
- Prefix lain **diabaikan** (default tolak), maksimal 20 kamar per koneksi.

Heartbeat `ping` dari server tiap 30 detik; klien yang tidak membalas `pong`
diputus.

---

## 🗃️ Model Data (17 entitas)

Didefinisikan di `prisma/schema.prisma`. Tiap kolom yang keputusannya tidak
jelas punya komentar `///` di berkas itu — baca di sana sebelum mengubah
bentuknya.

| Kelompok | Model | Peran |
| --- | --- | --- |
| **Identitas** | `Pengguna` | Akun warga dan petugas, peran lewat enum `Peran` |
| | `Sesi` | Refresh token (disimpan sebagai hash, bukan nilai asli) |
| | `KodeEmail` | Kode verifikasi & masuk perangkat baru, berbatas percobaan |
| **Jaringan** | `Zona` | Wilayah distribusi + batas GeoJSON |
| | `NeracaHarian` | Bacaan meter induk vs meter pelanggan, per zona per hari |
| | `Meter` | Meter air pelanggan: saldo, relay, firmware, RSSI |
| | `RiwayatMeter` | Jejak perubahan kepemilikan dan konfigurasi meter |
| | `EmberPemakaian` | Telemetri pemakaian per jam |
| **Komersial** | `Golongan` | Golongan tarif (Rp per liter) |
| | `Token` | Token air 10 digit: status, sumber, pemakaian sekali |
| | `Transaksi` | Invoice pembelian beserta status pelunasan |
| **Layanan** | `Tiket` | Pengaduan warga, nomor `LP-YYYY-MM-XXXX`, tenggat SLA |
| | `Insiden` | Anomali jaringan (kebocoran, gangguan) |
| **Operasional** | `Notifikasi` | Kotak masuk pengguna |
| | `Broadcast` | Siaran pengumuman |
| | `AuditLog` | Jejak rekam tindakan petugas |
| | `Pengaturan` | Konfigurasi tarif dan sistem |

---

## 🔐 Keamanan: yang benar-benar ditegakkan

Bagian ini mencatat apa yang **diuji**, bukan niat baik.

**Kata sandi dan sesi.** Argon2id untuk kata sandi. Access token 15 menit;
refresh token 30 hari, **disimpan sebagai hash** sehingga bocornya basis data
tidak langsung berarti sesi bisa dibajak. Rotasi di tiap `/refresh`.

**Pembatasan percobaan.** Kode email dan penukaran token punya batas percobaan
(`MAKS_PERCOBAAN_KODE = 5`) di samping rate limit per-IP. Rate limit saja
tidak cukup: penyerang dengan banyak alamat IP tetap bisa menebak kode enam
digit sampai tembus kalau kodenya sendiri tidak pernah terkunci.

**Webhook pembayaran.** Tanda tangan HMAC-SHA256 **wajib** — permintaan tanpa
tanda tangan ditolak. Bentuk tanda tangan diperiksa (`/^[0-9a-f]{64}$/i`)
sebelum `timingSafeEqual`, karena `timingSafeEqual` melempar kalau panjang
kedua penyangga berbeda, dan lemparan itu sendiri membocorkan informasi.

**Kode tidak pernah masuk log.** `subjekAman()` menyamarkan deret empat angka
atau lebih sebelum subjek email ditulis ke log server. Kode verifikasi yang
tercatat di log adalah kode yang bisa dibaca siapa pun yang punya akses log.

**Kepemilikan diperiksa di satu tempat.** Seluruh rute meter melewati
`pastikanAksesMeter()`. Warga hanya bisa menyentuh meter miliknya sendiri;
petugas boleh melihat semuanya.

**Kamar WebSocket default TOLAK.** Prefix yang tidak dikenal diabaikan, bukan
diterima. Versi sebelumnya menerima apa pun yang bukan `meter:`/`admin:`,
artinya prefix baru yang ditambahkan nanti otomatis terbuka untuk warga tanpa
ada yang menyadarinya — dan nama kamar sembarang dari query string bisa
membuat peta kamar tumbuh sesuai kemauan penyerang. Jumlah kamar dibatasi 20.

**Endpoint publik tanpa PII.** Tidak ada nama, alamat, kontak, nomor
sambungan, atau koordinat rumah di `/api/publik/*` mana pun — termasuk di
`/peta`, yang hanya mengirim poligon zona.

---

## 💧 Neraca Air: dari mana angka kehilangan air berasal

Bagian ini menjelaskan satu keputusan yang tidak kelihatan dari membaca kode.

**Masalahnya.** Air tak berekening (*non-revenue water*, NRW) adalah selisih
antara air yang **keluar dari instalasi** dan air yang **terbaca di meter
pelanggan**. Tabel `EmberPemakaian` hanya mengenal sisi pelanggan. Tanpa angka
pertama, NRW tidak bisa dihitung sama sekali — dan selama itu `/statistik`
mengirim `nrwPct: null`, sehingga ubin "Kehilangan air" di halaman depan
selamanya menampilkan "—" pada portal yang justru menjual transparansi
kehilangan air.

**Jawabannya.** Model `NeracaHarian` menyimpan dua angka berdampingan, satu
baris per zona per hari:

| Kolom | Artinya |
| --- | --- |
| `volumeIndukL` | Air yang keluar dari instalasi, dibaca meter induk zona |
| `volumeTercatatL` | Air yang sampai dan terbaca di meter pelanggan |

Seluruh endpoint hanya menjumlah dan membagi isi tabel ini. Tidak ada angka
yang dikarang saat permintaan masuk.

**Satu sumber hitungan.** `src/lib/neraca.ts` melayani `/statistik`,
`/neraca-air`, dan `/unduh` sekaligus. Kalau masing-masing menghitung sendiri,
ketiganya berselisih begitu rentang waktunya diganti — dan orang pertama yang
mencocokkan angka di layar dengan isi berkas unduhan akan menyimpulkan salah
satunya dikarang, tanpa tahu yang mana. Dijaga pengujian: `/statistik` dan
`/neraca-air` wajib mengirim angka yang sama pada rentang yang sama, dan isi
berkas unduhan wajib menjumlah kembali ke angka di layar.

**Rincian membagi habis.** Delapan komponen kerangka IWA dibagi memakai metode
sisa terbesar, bukan pembulatan biasa. Pembulatan biasa pada delapan baris
meleset beberapa m³, dan baris "jumlah" di halaman akan berbeda dari angka
besar di atasnya.

**Status datanya.** Isi `NeracaHarian` adalah data **peragaan** yang
dibangkitkan dari benih tetap di `prisma/neraca-demo.ts` — jaringan ini belum
punya meter induk fisik. Yang bukan peragaan adalah tempatnya: ia tersimpan di
basis data, dan API memperlakukannya sama seperti data sungguhan. Mengganti
sumbernya nanti cukup dengan mengisi tabel yang sama dari bacaan sebenarnya;
tidak ada baris kode endpoint yang perlu berubah.

Produksi hariannya **diturunkan dari jumlah sambungan**, tidak dipatok. Versi
pertama memakai 1180 m³/hari — angka masuk akal untuk sebuah kota, tetapi
basis data demo ini berisi 120 sambungan, dan halaman melaporkan 2.028
liter/orang/hari dengan "pemenuhan kebutuhan dasar" 3.381%. Sekarang sekitar
161 L/orang/hari.

---

## 🚢 Penyebaran (Deployment)

Push ke `main` memicu `.github/workflows/deploy.yml`: SSH lewat Cloudflare
Tunnel, `git reset --hard origin/main`, `docker compose up -d --build`, lalu
dua perintah di dalam kontainer.

```bash
docker compose exec -T app sh -c "npx prisma migrate deploy" < /dev/null
docker compose exec -T app sh -c "node dist/prisma/isi-neraca.js" < /dev/null
```

Tiga hal di dua baris itu yang mahal dipelajari:

**`< /dev/null` wajib pada setiap baris `exec`.** Badan skrip dikirim ke
server lewat stdin ssh (heredoc). `docker compose exec -T` mewarisi stdin yang
sama dan **menelan sisa skrip** sebagai masukan untuk perintah di dalam
kontainer. Selama hanya ada satu baris `exec` dan ia yang terakhir, tidak ada
yang hilang. Begitu baris kedua ditambahkan, baris itu tidak pernah
dijalankan — dan tidak ada yang gagal: `set -e` tidak melihat galat, log
berhenti begitu saja sesudah migrasi, job-nya hijau, dan satu-satunya tanda
adalah tabel yang tetap kosong di produksi.

**`node dist/...`, bukan `npx tsx`.** Image produksi menjalankan `npm prune
--omit=dev`, jadi `tsx` tidak ada di sana. `prisma/**/*.ts` ikut
`tsconfig.json`, sehingga `npm run build` sudah memancarkan
`dist/prisma/isi-neraca.js`.

**`isi-neraca.ts`, bukan `seed.ts`.** Seed mengosongkan seluruh tabel lebih
dulu; menjalankannya di server akan menghapus akun, tiket, dan transaksi yang
sudah ada. Skrip pengisi hanya menulis kalau `NeracaHarian` masih kosong, dan
berhenti tanpa menyentuh apa pun kalau sudah terisi — aman dijalankan setiap
kali deploy.

---

## 🔒 Standar Format Jawaban Galat (Error Contract)

Seluruh galat API dikembalikan dalam format JSON terstandarisasi dengan pesan Bahasa Indonesia yang siap dikonsumsi langsung oleh antarmuka frontend:

```json
{
  "error": {
    "code": "KREDENSIAL_SALAH",
    "message": "Email atau kata sandi salah."
  }
}
```

Format kesalahan validasi masukan (Zod):
```json
{
  "error": {
    "code": "VALIDASI_GAGAL",
    "message": "Data yang dikirim tidak memenuhi syarat.",
    "issues": [
      {
        "field": "kataSandi",
        "message": "Kata sandi minimal 8 karakter."
      }
    ]
  }
}
```

---

### Katalog kode galat

Kode bersifat stabil dan boleh dicocokkan di frontend; `message` bisa berubah
kapan saja dan **tidak boleh** dipakai sebagai penanda logika.

| Kelompok | Kode |
| --- | --- |
| **Umum** | `VALIDASI_GAGAL` · `NOT_FOUND` · `FORBIDDEN` · `CONFLICT` · `RATE_LIMIT` · `TERLALU_SERING` · `INTERNAL` |
| **Sesi** | `KREDENSIAL_SALAH` · `SESI_HABIS` · `SESI_DICABUT` · `SESI_TIDAK_VALID` · `AKUN_NONAKTIF` · `EMAIL_TERDAFTAR` · `EMAIL_BELUM_VERIFIKASI` · `PENGGUNA_TIDAK_DITEMUKAN` |
| **Kode email** | `KODE_SALAH` · `KODE_KEDALUWARSA` · `KODE_SUDAH_DIPAKAI` · `KODE_TERKUNCI` · `KODE_TIDAK_DITEMUKAN` · `PERCOBAAN_TERKUNCI` |
| **Meter** | `BUKAN_PEMILIK_METER` · `METER_SUDAH_TERHUBUNG` · `METER_TIDAK_COCOK` · `SALDO_HABIS` · `SAKLAR_OFF` |
| **Token air** | `TOKEN_INVALID` · `TOKEN_SUDAH_DIPAKAI` · `TOKEN_KEDALUWARSA` · `TOKEN_DIBATALKAN` · `TOKEN_TIDAK_ADA` |
| **Pembayaran** | `SIGNATURE_WAJIB` · `SIGNATURE_INVALID` · `INVOICE_WAJIB` · `BUKAN_PEMILIK_TRANSAKSI` · `BUKAN_PEMILIK_TAGIHAN` |
| **Unduhan publik** | `SET_TIDAK_DIKENAL` · `FORMAT_TIDAK_DIDUKUNG` |

---

## 📁 Struktur Direktori

```text
MIA-Jernih-Backend/
├── .github/workflows/          # Alur CI/CD otomatis (GitHub Actions)
│   └── deploy.yml
├── prisma/
│   ├── migrations/             # Berkas migrasi database PostgreSQL
│   ├── schema.prisma           # Skema 17 model entitas relasional
│   ├── neraca-demo.ts          # Pembangkit bacaan meter induk (dipakai seed DAN isi-neraca)
│   ├── isi-neraca.ts           # Mengisi NeracaHarian di server TANPA menghapus data lain
│   └── seed.ts                 # Script seeding data realistis (120 meter & akun)
├── src/
│   ├── lib/                    # Utilitas inti: auth, prisma client, email, errors, logger
│   │   ├── neraca.ts           # Satu sumber hitungan neraca air untuk 3 endpoint
│   │   └── unduh.ts            # Kumpulan data + penulis CSV (RFC 4180) & JSON
│   ├── middleware/             # Verifikasi sesi JWT, guard peran (RBAC), rate limiter
│   ├── rute/                   # Modular route controllers:
│   │   ├── auth.ts             # Registrasi, login, verifikasi OTP, reset password
│   │   ├── bayar.ts            # Paket tarif, pembayaran invoice, webhook
│   │   ├── geo.ts              # GeoJSON spasial konsol petugas
│   │   ├── insiden.ts          # Deteksi anomali kebocoran pipa otomatis
│   │   ├── konsol.ts           # Dasbor admin, pelanggan, perangkat, audit, pengaturan
│   │   ├── meter.ts            # Telemetri meter, kontrol valve relay, LCD firmware
│   │   ├── notifikasi.ts       # Manajemen pesan notifikasi pengguna
│   │   ├── publik.ts           # Endpoint transparansi terbuka tanpa login
│   │   ├── tiket.ts            # Pengaduan gangguan warga & kalkulasi SLA
│   │   └── token.ts            # Validasi & penukaran token air CSPRNG
│   ├── app.ts                  # Perakitan aplikasi Express & global error handler
│   ├── env.ts                  # Parsing & validasi konfigurasi environment (fail-fast)
│   ├── server.ts               # Entrypoint HTTP server & graceful shutdown
│   └── ws.ts                   # WebSocket manager & room broadcast engine
├── tests/                      # Rangkaian 14 suite tes integrasi (Vitest)
├── Dockerfile                  # Multi-stage Docker build production
├── docker-compose.example.yml  # Definisi compose untuk deployment & database test
├── package.json
└── tsconfig.json
```

---

## 🩺 Pemecahan Masalah

Gejala-gejala di bawah ini pernah benar-benar terjadi di proyek ini, lengkap
dengan sebab yang tidak kelihatan dari pesan galatnya.

**Seluruh tes gagal dengan `DatabaseDoesNotExist`.**
Basis data pengujian di porta 5435 belum jalan. Itu kegagalan lingkungan,
bukan kode — jalankan langkah 1 di bagian pengujian lebih dulu.

**Halaman frontend menampilkan rangka pemuatan selamanya, tanpa pesan galat.**
Hampir selalu CORS. Asal yang dipakai peramban tidak ada di `CORS_ORIGIN`.
Perhatikan bahwa `http://localhost:3000` dan `http://127.0.0.1:3000` adalah
**asal yang berbeda**, dan pengalihan apex → `www` **mengubah** header
`Origin` yang sampai ke sini. Periksa dengan:
```bash
curl -s -D- -o /dev/null -H "Origin: http://localhost:3000" \
  http://localhost:4000/api/publik/statistik | grep -i access-control
```
Tidak ada baris `Access-Control-Allow-Origin` berarti asalnya ditolak.

**Kehilangan air terbaca 0%, bukan "—".**
Tabel `NeracaHarian` kosong. Jalankan `node dist/prisma/isi-neraca.js` (di
server) atau `npm run db:seed` (lokal). Nol yang salah lebih merusak daripada
"—" yang jujur, karena ia terbaca seperti klaim.

**Penyebaran hijau tetapi perubahannya tidak terlihat di server.**
Periksa apakah ada `docker compose exec -T` tanpa `< /dev/null` di
`deploy.yml`. Exec mewarisi stdin ssh dan menelan sisa skripnya; baris
sesudahnya tidak pernah dijalankan dan **tidak ada yang gagal**.

**Webhook pembayaran membalas 400 untuk permintaan yang kelihatannya benar.**
`PAYMENT_WEBHOOK_SECRET` kosong. Itu perilaku yang disengaja, bukan bug.

**Email tidak terkirim saat pengembangan.**
`MAIL_ENABLED=false` adalah bawaannya. Kode verifikasi tetap dibuat dan
tersimpan di tabel `KodeEmail`; ambil dari sana, atau nyalakan SMTP.

**Prisma mengeluh klien tidak cocok dengan skema.**
Jalankan `npm run db:generate` setelah setiap perubahan `schema.prisma`.

---

## 👨‍💻 Tim Pengembang

Dikembangkan dengan dedikasi untuk kompetisi **Web In Action — MIA 2026** oleh Tim Jernih.
Mewujudkan layanan publik air bersih yang transparan, modern, dan akuntabel bagi seluruh warga.
