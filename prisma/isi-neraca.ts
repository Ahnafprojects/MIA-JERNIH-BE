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

/**
 * Apakah isi tabel masih sepadan dengan jumlah sambungan sekarang.
 *
 * Volume produksi diturunkan dari jumlah sambungan. Begitu sambungannya
 * bertambah banyak — misalnya 120 menjadi 420 — tabel lama menjadi terlalu
 * kecil, dan halaman statistik melaporkan pemakaian per orang yang anjlok
 * sampai di bawah kebutuhan pokok. Angkanya bukan salah hitung, melainkan
 * dua sumber yang tidak lagi sepadan.
 *
 * Isi tabel ini murni data peragaan, jadi menyusunnya ulang tidak menghapus
 * apa pun yang berharga. Ambangnya longgar (selisih di atas 40%) supaya
 * penambahan kecil tidak memicu penulisan ulang setiap kali deploy.
 */
async function masihSepadan(jumlahSambungan: number): Promise<boolean> {
  const terbaru = await prisma.neracaHarian.groupBy({
    by: ["tanggal"],
    _sum: { volumeIndukL: true },
    orderBy: { tanggal: "desc" },
    take: 1,
  });
  const indukL = terbaru[0]?._sum.volumeIndukL?.toNumber() ?? 0;
  if (indukL <= 0) return false;

  /*
   * Rumus yang sama dengan `neraca-demo.ts`, dalam LITER.
   *
   * `produksiDasarM3` di sana membagi hasil kalinya dengan 1000 untuk
   * mendapat meter kubik. Kolom yang disimpan satuannya liter, jadi
   * pembagian itu tidak diulang di sini. Versi pertama tetap mengalikan
   * 1000, sehingga harapannya seribu kali terlalu besar dan tabelnya
   * disusun ulang pada setiap deploy.
   */
  const harapanL = (jumlahSambungan * 3.9 * 158) / (1 - 0.21);
  const selisih = Math.abs(indukL - harapanL) / harapanL;
  return selisih <= 0.4;
}

async function utama(): Promise<void> {
  const jumlahSambungan = await prisma.meter.count();

  const sudahAda = await prisma.neracaHarian.count();
  if (sudahAda > 0) {
    if (await masihSepadan(jumlahSambungan)) {
      console.log(`NeracaHarian sudah berisi ${sudahAda} baris — tidak diubah.`);
      return;
    }
    console.log(
      `NeracaHarian tidak lagi sepadan dengan ${jumlahSambungan} sambungan — disusun ulang.`,
    );
    await prisma.neracaHarian.deleteMany();
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
