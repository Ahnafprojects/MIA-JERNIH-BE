-- AlterTable
ALTER TABLE "Pengguna" ADD COLUMN     "akunDemo" BOOLEAN NOT NULL DEFAULT false;

-- Menandai akun peragaan yang SUDAH ADA di basis data.
--
-- Tanpa baris ini, kolomnya bernilai false untuk seluruh akun yang terlanjur
-- dibuat seed sebelumnya, dan akun demo di produksi tetap terkunci di balik
-- verifikasi perangkat baru. Kodenya dikirim ke alamat @jernih.id yang tidak
-- punya kotak surat, jadi tidak ada yang bisa membukanya.
--
-- Domainnya dipakai sebagai penanda karena hanya seed yang membuat akun
-- dengan domain tersebut. Akun warga sungguhan memakai domain lain dan tidak
-- tersentuh pernyataan ini.
UPDATE "Pengguna" SET "akunDemo" = true WHERE "email" LIKE '%@jernih.id';
