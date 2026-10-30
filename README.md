# Jernih — Backend API

> **Platform Transparansi Layanan Air Bersih PDAM Terintegrasi Smart Metering & Pelacakan Publik**  
> Dibuat untuk **Web In Action — Multimedia In Action (MIA) 2026**, Subtema: **Public Service Tracking**.

- **URL Backend Live:** [https://be-jernih.ahnaf.cloud](https://be-jernih.ahnaf.cloud) (Health Check: [`/health`](https://be-jernih.ahnaf.cloud/health))
- **URL Frontend Live:** [https://jernih.biz.id](https://jernih.biz.id) ([Repositori Frontend](https://github.com/Ahnafprojects/MIA-JERNIH-FE))
- **Status CI/CD:** [![Deploy](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml/badge.svg)](https://github.com/Ahnafprojects/MIA-JERNIH-BE/actions/workflows/deploy.yml) (Automated GitHub Actions via Cloudflare Tunnel)
- **Status Pengujian:** 50/50 Tests Passed (13 Test Suites Vitest, 100% Lolos)

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

Lima meter terakhir sengaja dibiarkan **tanpa pemilik**, supaya alur "hubungkan
meter" bisa diperagakan dengan akun yang baru didaftarkan:

```
JRN-10115   JRN-10116   JRN-10117   JRN-10118   JRN-10119
```

Daftar akun lalu masukkan salah satu serial di layar **Hubungkan Meter**. Satu
serial hanya bisa diklaim satu kali — meter yang sudah bertuan akan ditolak
dengan `METER_SUDAH_TERHUBUNG`. Jalankan `npm run db:seed` lagi untuk
mengembalikan kelimanya.

---

## 🧪 Menjalankan Pengujian Otomatis (Test Suite)

Repositori ini dilengkapi rangkaian tes otomatis komprehensif yang menguji seluruh aspek fungsionalitas, keamanan, dan integritas data (50 unit & integration tests).

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
- `GET /api/publik/statistik` — Total meter, pelanggan terdaftar, dan agregat volume distribusi
- `GET /api/publik/peta` — GeoJSON poligon batas zona dan rekapitulasi gangguan wilayah

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
- **URL Koneksi:** `ws://<host>/ws?token=<accessToken>&rooms=meter:<meterId>`
- **Fitur:** Heartbeat ping/pong otomatis setiap 30 detik, isolasi otorisasi kamar, push relay event, saldo meter, dan sinkronisasi live dashboard.

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

## 📁 Struktur Direktori

```text
MIA-Jernih-Backend/
├── .github/workflows/          # Alur CI/CD otomatis (GitHub Actions)
│   └── deploy.yml
├── prisma/
│   ├── migrations/             # Berkas migrasi database PostgreSQL
│   ├── schema.prisma           # Skema 15 model entitas relasional
│   └── seed.ts                 # Script seeding data realistis (120 meter & akun)
├── src/
│   ├── lib/                    # Utilitas inti: auth, prisma client, email, errors, logger
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
├── tests/                      # Rangkaian 13 suite tes integrasi (Vitest)
├── Dockerfile                  # Multi-stage Docker build production
├── docker-compose.example.yml  # Definisi compose untuk deployment & database test
├── package.json
└── tsconfig.json
```

---

## 👨‍💻 Tim Pengembang

Dikembangkan dengan dedikasi untuk kompetisi **Web In Action — MIA 2026** oleh Tim Jernih.
Mewujudkan layanan publik air bersih yang transparan, modern, dan akuntabel bagi seluruh warga.
