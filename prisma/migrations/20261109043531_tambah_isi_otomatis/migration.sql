-- AlterTable
ALTER TABLE "Meter" ADD COLUMN     "isiOtomatisAktif" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isiOtomatisAmbangL" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "isiOtomatisTerakhir" TIMESTAMP(3),
ADD COLUMN     "isiOtomatisVolumeL" INTEGER NOT NULL DEFAULT 1000;
