# Panduan untuk agen — Jernih Backend

Dibaca otomatis oleh Claude Code, Cursor, dan agen sejenis.
Berlaku untuk manusia maupun agen.

> Simpan berkas ini di folder repo, TAPI jangan di-commit. Kedua repo
> sudah memasukkan `AGENTS.md` ke `.gitignore`, jadi git akan
> mengabaikannya dengan sendirinya.

## Konteks

API Jernih, platform transparansi layanan air PDAM untuk lomba **Web In
Action MIA 2026**, subtema **Public Service Tracking**. Frontend terpisah di
repo `MIA-JERNIH-FE`.

Tiga kelompok pengguna: **publik** (tanpa login), **warga**, **petugas PDAM**
(operator, supervisor, teknisi).

## Aturan yang tidak boleh dilanggar

1. **Pesan galat Bahasa Indonesia, siap tampil.** Bentuknya selalu
   `{error:{code,message}}`. Sebutkan apa yang salah DAN apa yang harus
   dilakukan: *"Token salah atau sudah dipakai. Periksa kode di struk atau
   email Anda."*
2. **Verifikasi hanya lewat kode 6 digit di email.** Tidak ada OTP SMS atau
   telepon di mana pun. Nomor HP hanya untuk dihubungi petugas.
3. **Token = angka saja, 4–10 digit, sekali pakai, terikat satu meter.**
   Berlaku 30 hari. Salah 5 kali berturut-turut → jeda 10 menit. Token demo
   firmware `1111` (+5 L) dan `2222` (+10 L) selalu diterima.
4. **Kode token disimpan sebagai hash**, tidak pernah plaintext. Kode utuh
   hanya keluar dua kali: di email struk, dan di jawaban pembelian yang
   langsung lunas. Tidak di endpoint lain, tidak di log.
5. **Pembelian tidak menambah saldo meter.** Alurnya: bayar → token terbit →
   dikirim ke meter lewat MQTT → **METER** yang menerapkannya lalu melapor
   balik. Menambah saldo di sisi server membuat token terpakai dua kali.
6. **Relay hanya aktif bila saldo > 0 DAN saklar fisik ON.** Dua kondisi
   berbeda, simpan dan tampilkan terpisah.
7. **Aksi berisiko wajib masuk AuditLog**: tutup/buka relay, kirim konfigurasi
   meter, broadcast, ubah tarif, nonaktifkan anggota tim. AuditLog
   append-only — jangan pernah membuat endpoint ubah atau hapus. Inilah yang
   membuat klaim akuntabilitas di halaman publik bisa dipercaya.
8. **Endpoint publik tidak boleh membocorkan data pribadi.** Nama, alamat,
   email, dan saldo warga TIDAK pernah muncul di `/api/publik/*`. Yang boleh
   keluar hanya agregat per zona dan status tiket tanpa identitas pelapor.
9. **Jangan menaruh rahasia di repo.** Semua lewat `.env`, contohnya di
   `.env.example`.

## Satuan

- Saldo, token, paket, pemakaian: **liter**. Debit: **L/mnt**.
- Agregat jaringan untuk petugas boleh **m³** (1 m³ = 1.000 L).
- Tarif contoh Rp 7,5/L, per golongan, bisa diubah petugas.

## Alarm meter (ditentukan firmware, jangan diubah sepihak)

| Saldo | Perilaku meter |
| --- | --- |
| ≤ 5 L | bip 100 ms tiap 10 detik |
| ≤ 2 L | bip tiap 2 detik |
| 0 L | buzzer menyala terus, relay mati |

Peringatan aplikasi/email **terpisah** dari alarm meter (bawaan < 100 L, bisa
diatur 50/100/250/500 L).

## Cara kerja

- Satu issue = satu PR.
- `npm run typecheck && npm run test` harus bersih sebelum push. Jangan
  mematikan aturan lint atau menghapus tes untuk membuatnya lolos.
- Setiap aturan bisnis wajib ada tesnya: validasi token, jeda setelah 5 kali
  salah, verifikasi email, syarat relay, ambang alarm, perhitungan SLA.
- Perubahan `prisma/schema.prisma` lewat PR tersendiri — semua modul
  bergantung padanya.

## Jebakan yang sudah pernah menjatuhkan proyek ini

- **401 dari `/auth/*` berarti kredensial salah, bukan sesi kedaluwarsa.**
  Kirim pesan yang tepat; frontend sudah membedakan keduanya.
- **Jangan membatasi masuk terlalu ketat per IP.** Rate limiter menghitung
  SETIAP permintaan, bukan hanya yang gagal, jadi satu kantor di balik satu
  NAT terkunci padahal kata sandinya benar. Pertahanan sebenarnya ada di
  lapisan per-akun. 20/menit/IP sudah cukup.
- **`kpi` dikirim sebagai ARRAY** `{key,label,value,unit?,delta?,tone?}`,
  bukan objek ber-kunci. Frontend mencarinya lewat `key`.
- **Nilai yang hilang ≠ 0.** Kalau sebuah KPI tidak bisa dihitung, jangan
  kirim 0 — kirim tanpa entri itu, supaya UI menampilkan "—" dan bukan angka
  nol yang terbaca sebagai hasil pengukuran.
