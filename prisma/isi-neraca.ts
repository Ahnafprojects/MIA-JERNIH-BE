/**
 * Mengisi `NeracaHarian` di basis data yang SUDAH berisi data.
 *
 * Kenapa ini terpisah dari `seed.ts`: seed mengosongkan seluruh tabel lebih
 * dulu. Menjalankannya di server akan menghapus akun, tiket, dan transaksi
 * yang sudah ada — harga yang jauh terlalu mahal untuk mengisi satu tabel
 * baru.
 *
 * Dijalankan sesudah `prisma migrate deploy`. Migrasi membuat tabelnya, tetapi
 * tabel kosong membuat `/statistik` melaporkan kehilangan air 0% — dan 0% yang
 * salah jauh lebih merusak daripada "—" yang jujur, karena ia terbaca seperti
 * klaim.
 *
 * AMAN DIJALANKAN BERULANG. Kalau tabelnya sudah terisi, skrip ini berhenti
 * tanpa menulis apa pun; ia tidak pernah menimpa bacaan yang sudah ada.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { HARI_NERACA, PORSI_ZONA, barisNeraca } from "./neraca-demo.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function utama(): Promise<void> {
  const sudahAda = await prisma.neracaHarian.count();
  if (sudahAda > 0) {
    console.log(`NeracaHarian sudah berisi ${sudahAda} baris — tidak diubah.`);
    return;
  }

  const zona = await prisma.zona.findMany({ select: { id: true, nama: true } });
  if (zona.length === 0) {
    // Bukan galat: basis data yang benar-benar baru akan diisi `seed.ts`,
    // dan skrip ini berjalan sebelum itu pada urutan penyebaran tertentu.
    console.log("Belum ada zona — tidak ada yang bisa diisi.");
    return;
  }

  const dikenal = zona.filter((z) => z.nama in PORSI_ZONA);
  if (dikenal.length === 0) {
    /*
     * Berhenti, jangan menebak.
     *
     * Porsi produksi tiap zona ditentukan per nama di `neraca-demo.ts`.
     * Jaringan dengan nama zona lain menuntut porsinya sendiri; membagi rata
     * akan menghasilkan angka yang terlihat masuk akal padahal tidak diambil
     * dari mana pun — persis jenis angka yang tidak bisa ditarik kembali
     * setelah dikutip orang.
     */
    console.error(
      `Tidak ada zona yang dikenal. Yang ada di basis data: ${zona
        .map((z) => z.nama)
        .join(", ")}. Yang punya porsi: ${Object.keys(PORSI_ZONA).join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }

  const jumlahSambungan = await prisma.meter.count();
  if (jumlahSambungan === 0) {
    console.log("Belum ada meter — produksi tidak bisa diskalakan.");
    return;
  }

  const idPerNama = new Map(dikenal.map((z) => [z.nama, z.id]));
  const baris = barisNeraca(idPerNama, jumlahSambungan);

  for (let i = 0; i < baris.length; i += 3000) {
    await prisma.neracaHarian.createMany({
      data: baris.slice(i, i + 3000),
      // Kalau dua penyebaran berjalan beriringan, yang kedua melewati baris
      // yang sudah ditulis alih-alih gagal di tengah jalan.
      skipDuplicates: true,
    });
  }

  console.log(
    `NeracaHarian terisi: ${baris.length} baris — ${HARI_NERACA} hari x ${dikenal.length} zona, ${jumlahSambungan} sambungan.`,
  );
}

utama()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
