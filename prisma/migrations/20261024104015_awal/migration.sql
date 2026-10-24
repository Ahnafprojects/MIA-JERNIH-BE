-- CreateEnum
CREATE TYPE "Peran" AS ENUM ('WARGA', 'OPERATOR', 'SUPERVISOR', 'TEKNISI');

-- CreateEnum
CREATE TYPE "StatusRelay" AS ENUM ('AKTIF', 'NONAKTIF');

-- CreateEnum
CREATE TYPE "StatusToken" AS ENUM ('AKTIF', 'TERPAKAI', 'KEDALUWARSA', 'DIBATALKAN');

-- CreateEnum
CREATE TYPE "SumberToken" AS ENUM ('PEMBELIAN', 'ADMIN', 'DEMO');

-- CreateEnum
CREATE TYPE "JenisTransaksi" AS ENUM ('BELI', 'ISI_TOKEN');

-- CreateEnum
CREATE TYPE "StatusTransaksi" AS ENUM ('MENUNGGU', 'LUNAS', 'GAGAL', 'KEDALUWARSA');

-- CreateEnum
CREATE TYPE "MetodeBayar" AS ENUM ('QRIS', 'VA', 'EWALLET', 'GERAI');

-- CreateEnum
CREATE TYPE "StatusTiket" AS ENUM ('BARU', 'DIPROSES', 'SELESAI');

-- CreateEnum
CREATE TYPE "StatusInsiden" AS ENUM ('BARU', 'DITUGASKAN', 'SELESAI');

-- CreateEnum
CREATE TYPE "Keparahan" AS ENUM ('RINGAN', 'SEDANG', 'BERAT');

-- CreateTable
CREATE TABLE "Pengguna" (
    "id" TEXT NOT NULL,
    "nama" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "kataSandiHash" TEXT NOT NULL,
    "hp" TEXT,
    "alamat" TEXT,
    "peran" "Peran" NOT NULL DEFAULT 'WARGA',
    "zonaId" TEXT,
    "golonganId" TEXT,
    "emailTerverifikasiPada" TIMESTAMP(3),
    "aktif" BOOLEAN NOT NULL DEFAULT true,
    "ambangPeringatanL" INTEGER NOT NULL DEFAULT 100,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diubahPada" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pengguna_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sesi" (
    "id" TEXT NOT NULL,
    "penggunaId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "perangkat" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "terakhirPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dicabutPada" TIMESTAMP(3),
    "kedaluwarsaPada" TIMESTAMP(3) NOT NULL,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sesi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KodeEmail" (
    "id" TEXT NOT NULL,
    "penggunaId" TEXT,
    "email" TEXT NOT NULL,
    "kodeHash" TEXT NOT NULL,
    "tujuan" TEXT NOT NULL,
    "percobaan" INTEGER NOT NULL DEFAULT 0,
    "dipakaiPada" TIMESTAMP(3),
    "kedaluwarsaPada" TIMESTAMP(3) NOT NULL,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KodeEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zona" (
    "id" TEXT NOT NULL,
    "nama" TEXT NOT NULL,
    "batasGeo" JSONB,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Zona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meter" (
    "id" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "alamat" TEXT NOT NULL DEFAULT '',
    "zonaId" TEXT,
    "penggunaId" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "saldoL" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "volumeTotalL" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "debitLpm" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "relay" "StatusRelay" NOT NULL DEFAULT 'NONAKTIF',
    "saklarOn" BOOLEAN NOT NULL DEFAULT true,
    "daring" BOOLEAN NOT NULL DEFAULT false,
    "terakhirTerlihat" TIMESTAMP(3),
    "ambangPeringatanL" DECIMAL(10,2) NOT NULL DEFAULT 5,
    "ambangKritisL" DECIMAL(10,2) NOT NULL DEFAULT 2,
    "kalibrasi" DECIMAL(10,2) NOT NULL DEFAULT 6.55,
    "panjangToken" INTEGER NOT NULL DEFAULT 10,
    "versiFirmware" TEXT NOT NULL DEFAULT '',
    "rssi" INTEGER,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diubahPada" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiwayatMeter" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "saldoL" DECIMAL(14,2) NOT NULL,
    "debitLpm" DECIMAL(10,2) NOT NULL,
    "volumeL" DECIMAL(14,2) NOT NULL,
    "saklarOn" BOOLEAN NOT NULL,
    "relay" "StatusRelay" NOT NULL,
    "buzzer" TEXT NOT NULL DEFAULT 'off',
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiwayatMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmberPemakaian" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "jam" TIMESTAMP(3) NOT NULL,
    "volumeL" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "EmberPemakaian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Golongan" (
    "id" TEXT NOT NULL,
    "nama" TEXT NOT NULL,
    "tarifPerLiter" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "Golongan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "kodeHash" TEXT NOT NULL,
    "kodeAwalan" TEXT NOT NULL,
    "nilaiL" DECIMAL(14,2) NOT NULL,
    "status" "StatusToken" NOT NULL DEFAULT 'AKTIF',
    "sumber" "SumberToken" NOT NULL DEFAULT 'PEMBELIAN',
    "meterId" TEXT,
    "pemilikId" TEXT,
    "pembuatId" TEXT,
    "transaksiId" TEXT,
    "dipakaiPada" TIMESTAMP(3),
    "dipakaiMeterId" TEXT,
    "kedaluwarsaPada" TIMESTAMP(3) NOT NULL,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaksi" (
    "id" TEXT NOT NULL,
    "penggunaId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "jenis" "JenisTransaksi" NOT NULL,
    "volumeL" DECIMAL(14,2) NOT NULL,
    "jumlahRp" DECIMAL(14,2) NOT NULL,
    "metode" "MetodeBayar" NOT NULL,
    "status" "StatusTransaksi" NOT NULL DEFAULT 'MENUNGGU',
    "qrString" TEXT,
    "nomorVa" TEXT,
    "kodeGerai" TEXT,
    "refEksternal" TEXT,
    "dibayarPada" TIMESTAMP(3),
    "kedaluwarsaPada" TIMESTAMP(3),
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaksi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tiket" (
    "id" TEXT NOT NULL,
    "nomor" TEXT NOT NULL,
    "pelaporId" TEXT NOT NULL,
    "meterId" TEXT,
    "kategori" TEXT NOT NULL,
    "deskripsi" TEXT NOT NULL,
    "fotoUrl" TEXT[],
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "StatusTiket" NOT NULL DEFAULT 'BARU',
    "teknisiId" TEXT,
    "slaJatuhTempo" TIMESTAMP(3) NOT NULL,
    "selesaiPada" TIMESTAMP(3),
    "penilaian" INTEGER,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diubahPada" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tiket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insiden" (
    "id" TEXT NOT NULL,
    "meterId" TEXT,
    "tipe" TEXT NOT NULL,
    "keparahan" "Keparahan" NOT NULL DEFAULT 'SEDANG',
    "judul" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" "StatusInsiden" NOT NULL DEFAULT 'BARU',
    "teknisiId" TEXT,
    "dibukaPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ditutupPada" TIMESTAMP(3),

    CONSTRAINT "Insiden_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notifikasi" (
    "id" TEXT NOT NULL,
    "penggunaId" TEXT NOT NULL,
    "jenis" TEXT NOT NULL,
    "judul" TEXT NOT NULL,
    "teks" TEXT NOT NULL,
    "tautan" TEXT,
    "broadcastId" TEXT,
    "dibacaPada" TIMESTAMP(3),
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notifikasi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "zona" TEXT,
    "judul" TEXT NOT NULL,
    "pesan" TEXT NOT NULL,
    "kanalPush" BOOLEAN NOT NULL DEFAULT true,
    "kanalEmail" BOOLEAN NOT NULL DEFAULT false,
    "dijadwalkanPada" TIMESTAMP(3),
    "dikirimPada" TIMESTAMP(3),
    "penerima" INTEGER NOT NULL DEFAULT 0,
    "dibuka" INTEGER NOT NULL DEFAULT 0,
    "pembuatId" TEXT NOT NULL,
    "dibuatPada" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "aktorId" TEXT,
    "aktorNama" TEXT NOT NULL DEFAULT '',
    "aksi" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "tipe" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pengaturan" (
    "kunci" TEXT NOT NULL,
    "nilai" JSONB NOT NULL,
    "diubahPada" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pengaturan_pkey" PRIMARY KEY ("kunci")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pengguna_email_key" ON "Pengguna"("email");

-- CreateIndex
CREATE INDEX "Pengguna_peran_idx" ON "Pengguna"("peran");

-- CreateIndex
CREATE INDEX "Pengguna_zonaId_idx" ON "Pengguna"("zonaId");

-- CreateIndex
CREATE UNIQUE INDEX "Sesi_refreshHash_key" ON "Sesi"("refreshHash");

-- CreateIndex
CREATE INDEX "Sesi_penggunaId_idx" ON "Sesi"("penggunaId");

-- CreateIndex
CREATE INDEX "KodeEmail_email_tujuan_idx" ON "KodeEmail"("email", "tujuan");

-- CreateIndex
CREATE UNIQUE INDEX "Zona_nama_key" ON "Zona"("nama");

-- CreateIndex
CREATE UNIQUE INDEX "Meter_node_key" ON "Meter"("node");

-- CreateIndex
CREATE UNIQUE INDEX "Meter_serial_key" ON "Meter"("serial");

-- CreateIndex
CREATE INDEX "Meter_zonaId_idx" ON "Meter"("zonaId");

-- CreateIndex
CREATE INDEX "Meter_penggunaId_idx" ON "Meter"("penggunaId");

-- CreateIndex
CREATE INDEX "Meter_daring_idx" ON "Meter"("daring");

-- CreateIndex
CREATE INDEX "RiwayatMeter_meterId_ts_idx" ON "RiwayatMeter"("meterId", "ts");

-- CreateIndex
CREATE INDEX "EmberPemakaian_jam_idx" ON "EmberPemakaian"("jam");

-- CreateIndex
CREATE UNIQUE INDEX "EmberPemakaian_meterId_jam_key" ON "EmberPemakaian"("meterId", "jam");

-- CreateIndex
CREATE UNIQUE INDEX "Golongan_nama_key" ON "Golongan"("nama");

-- CreateIndex
CREATE UNIQUE INDEX "Token_kodeHash_key" ON "Token"("kodeHash");

-- CreateIndex
CREATE INDEX "Token_pemilikId_status_idx" ON "Token"("pemilikId", "status");

-- CreateIndex
CREATE INDEX "Token_meterId_idx" ON "Token"("meterId");

-- CreateIndex
CREATE INDEX "Transaksi_penggunaId_status_idx" ON "Transaksi"("penggunaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tiket_nomor_key" ON "Tiket"("nomor");

-- CreateIndex
CREATE INDEX "Tiket_status_idx" ON "Tiket"("status");

-- CreateIndex
CREATE INDEX "Tiket_nomor_idx" ON "Tiket"("nomor");

-- CreateIndex
CREATE INDEX "Insiden_status_idx" ON "Insiden"("status");

-- CreateIndex
CREATE INDEX "Insiden_meterId_idx" ON "Insiden"("meterId");

-- CreateIndex
CREATE INDEX "Notifikasi_penggunaId_dibacaPada_idx" ON "Notifikasi"("penggunaId", "dibacaPada");

-- CreateIndex
CREATE INDEX "AuditLog_tipe_ts_idx" ON "AuditLog"("tipe", "ts");

-- AddForeignKey
ALTER TABLE "Pengguna" ADD CONSTRAINT "Pengguna_zonaId_fkey" FOREIGN KEY ("zonaId") REFERENCES "Zona"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pengguna" ADD CONSTRAINT "Pengguna_golonganId_fkey" FOREIGN KEY ("golonganId") REFERENCES "Golongan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sesi" ADD CONSTRAINT "Sesi_penggunaId_fkey" FOREIGN KEY ("penggunaId") REFERENCES "Pengguna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KodeEmail" ADD CONSTRAINT "KodeEmail_penggunaId_fkey" FOREIGN KEY ("penggunaId") REFERENCES "Pengguna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_zonaId_fkey" FOREIGN KEY ("zonaId") REFERENCES "Zona"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_penggunaId_fkey" FOREIGN KEY ("penggunaId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiwayatMeter" ADD CONSTRAINT "RiwayatMeter_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmberPemakaian" ADD CONSTRAINT "EmberPemakaian_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_pemilikId_fkey" FOREIGN KEY ("pemilikId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_pembuatId_fkey" FOREIGN KEY ("pembuatId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_transaksiId_fkey" FOREIGN KEY ("transaksiId") REFERENCES "Transaksi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaksi" ADD CONSTRAINT "Transaksi_penggunaId_fkey" FOREIGN KEY ("penggunaId") REFERENCES "Pengguna"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaksi" ADD CONSTRAINT "Transaksi_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tiket" ADD CONSTRAINT "Tiket_pelaporId_fkey" FOREIGN KEY ("pelaporId") REFERENCES "Pengguna"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tiket" ADD CONSTRAINT "Tiket_teknisiId_fkey" FOREIGN KEY ("teknisiId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tiket" ADD CONSTRAINT "Tiket_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insiden" ADD CONSTRAINT "Insiden_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insiden" ADD CONSTRAINT "Insiden_teknisiId_fkey" FOREIGN KEY ("teknisiId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifikasi" ADD CONSTRAINT "Notifikasi_penggunaId_fkey" FOREIGN KEY ("penggunaId") REFERENCES "Pengguna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifikasi" ADD CONSTRAINT "Notifikasi_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_pembuatId_fkey" FOREIGN KEY ("pembuatId") REFERENCES "Pengguna"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_aktorId_fkey" FOREIGN KEY ("aktorId") REFERENCES "Pengguna"("id") ON DELETE SET NULL ON UPDATE CASCADE;
