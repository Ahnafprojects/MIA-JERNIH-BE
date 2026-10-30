-- CreateTable
CREATE TABLE "NeracaHarian" (
    "id" TEXT NOT NULL,
    "zonaId" TEXT NOT NULL,
    "tanggal" DATE NOT NULL,
    "volumeIndukL" DECIMAL(14,2) NOT NULL,
    "volumeTercatatL" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "NeracaHarian_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NeracaHarian_tanggal_idx" ON "NeracaHarian"("tanggal");

-- CreateIndex
CREATE UNIQUE INDEX "NeracaHarian_zonaId_tanggal_key" ON "NeracaHarian"("zonaId", "tanggal");

-- AddForeignKey
ALTER TABLE "NeracaHarian" ADD CONSTRAINT "NeracaHarian_zonaId_fkey" FOREIGN KEY ("zonaId") REFERENCES "Zona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
