# Jernih — Backend

API untuk platform transparansi layanan air PDAM: data warga, meter, token,
pengaduan, dan **endpoint publik tanpa autentikasi** yang membuka status
layanan serta rapor kinerja instansi kepada siapa pun.

Dibuat untuk **Web In Action — Multimedia In Action (MIA) 2026**, subtema
**Public Service Tracking**.

## Tech stack

| Lapisan | Teknologi |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | Express 5 |
| Bahasa | TypeScript 5 |
| ORM | Prisma 7 + PostgreSQL |
| Validasi | Zod 4 |
| Kata sandi | argon2id |
| Token sesi | JWT (jose) — akses 15 menit, refresh 30 hari |
| Email | Nodemailer (SMTP) |
| Realtime | WebSocket (`ws`) |
| IoT | MQTT ke meter ESP32 |
| Tes | Vitest + Supertest |

Frontend terpisah: [MIA-JERNIH-FE](https://github.com/Ahnafprojects/MIA-JERNIH-FE)
(Next.js 16 + Tailwind v4).

## Cara menjalankan

```bash
# 1. clone
git clone https://github.com/Ahnafprojects/MIA-JERNIH-BE.git
cd MIA-JERNIH-BE

# 2. install
npm install

# 3. konfigurasi
cp .env.example .env
# isi DATABASE_URL dan JWT_SECRET (minimal 32 karakter)

# 4. siapkan database
npm run db:migrate
npm run db:seed

# 5. run
npm run dev
```

API berjalan di http://localhost:4000. Cek `GET /health`.

PostgreSQL cepat lewat Docker:

```bash
docker run -d --name jernih-db -p 5432:5432 \
  -e POSTGRES_USER=jernih -e POSTGRES_PASSWORD=jernih -e POSTGRES_DB=jernih \
  postgres:17-alpine
```

Perintah lain:

```bash
npm run build      # kompilasi ke dist/
npm run typecheck  # tsc --noEmit
npm run test       # Vitest
npm run db:studio  # Prisma Studio
```

## Struktur

```
src/
├── server.ts      titik masuk, buka port, matikan dengan rapi
├── app.ts         perakitan Express (dipisah agar bisa dites tanpa port)
├── env.ts         konfigurasi divalidasi Zod, gagal cepat saat mulai
├── lib/           prisma · errors · log
├── middleware/    auth, peran, rate limit per endpoint
└── modules/       satu folder per domain: auth, meter, token, …
prisma/
├── schema.prisma  model data — ubah hanya lewat PR tersendiri
└── seed.ts        data demo yang masuk akal
```

## Progres saat ini

- [x] Fondasi Express 5 + TypeScript + Prisma 7
- [x] Skema database lengkap (15 model)
- [x] Konfigurasi tervalidasi, penanganan galat seragam, logger teredaksi
- [ ] Autentikasi & sesi
- [ ] Endpoint publik (status layanan, lacak tiket, rapor kinerja, statistik)
- [ ] Meter, token, pembayaran, tiket, insiden
- [ ] Endpoint konsol petugas
- [ ] Realtime WebSocket & jembatan MQTT

Rincian tiap modul ada di **Issues** repo ini.

## Kontrak jawaban

Semua galat memakai satu bentuk:

```json
{ "error": { "code": "KREDENSIAL_SALAH", "message": "Email atau kata sandi salah." } }
```

`message` **selalu Bahasa Indonesia dan siap tampil apa adanya**. Frontend
tidak boleh menyusun kalimatnya sendiri dari kode status — kalau ia
melakukannya, pesan yang tepat dari sini akan tertimpa pesan generik dan
pengguna kehilangan petunjuk sebenarnya.
