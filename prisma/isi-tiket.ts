/**
 * Menambah tiket pengaduan di basis data yang SUDAH berisi data.
 *
 * Terpisah dari `seed.ts` dengan alasan yang sama seperti `isi-neraca.ts`:
 * seed mengosongkan seluruh tabel lebih dulu, dan menjalankannya di server
 * akan menghapus akun, transaksi, serta tiket sungguhan.
 *
 * Masalah yang diselesaikan: basis data produksi berisi 60 tiket tersebar 25
 * hari, sehingga rentang 90 hari di halaman Rapor Kinerja hanya mengisi 4
 * dari 13 titik grafik. Sisanya kosong karena memang tidak ada tiket yang
 * selesai pada pekan-pekan itu.
 *
 * AMAN DIJALANKAN BERULANG. Skrip berhenti tanpa menulis apa pun begitu
 * jumlah tiket sudah mencapai target, dan nomor tiket baru selalu melanjutkan
 * urutan yang sudah terpakai di bulan bersangkutan.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { TARGET_TIKET, barisTiket } from "./tiket-demo.js";
import { acak } from "./neraca-demo.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Benih tetap, supaya menjalankan ulang menghasilkan tiket yang sama. */
const BENIH_TIKET = 20261031;

async function utama(): Promise<void> {
  const sudahAda = await prisma.tiket.count();
  if (sudahAda >= TARGET_TIKET) {
    console.log(`Tiket sudah ${sudahAda} (target ${TARGET_TIKET}) — tidak diubah.`);
    return;
  }

  const meter = await prisma.meter.findMany({
    where: { penggunaId: { not: null } },
    select: { id: true, penggunaId: true },
    take: 60,
  });
  if (meter.length === 0) {
    console.log("Belum ada meter bertuan — tidak ada yang bisa melapor.");
    return;
  }

  const teknisi = await prisma.pengguna.findFirst({
    where: { peran: "TEKNISI" },
    select: { id: true },
  });
  if (!teknisi) {
    console.log("Belum ada akun teknisi — tiket tidak bisa ditugaskan.");
    return;
  }

  /*
   * Melanjutkan penomoran yang sudah ada, bukan memulai dari 1.
   *
   * Kolom `nomor` bersifat unik. Tanpa membaca urutan terpakai, tiket baru
   * pada bulan yang sama akan bertabrakan dengan yang lama dan seluruh
   * penulisan gagal di tengah jalan.
   */
  const nomorAda = await prisma.tiket.findMany({ select: { nomor: true } });
  const urutTerpakai = new Map<string, number>();
  for (const { nomor } of nomorAda) {
    const cocok = /^LP-(\d{4}-\d{2})-(\d+)$/.exec(nomor);
    if (!cocok) continue;
    const bulan = cocok[1]!;
    const urut = Number(cocok[2]);
    if (urut > (urutTerpakai.get(bulan) ?? 0)) urutTerpakai.set(bulan, urut);
  }

  const kurang = TARGET_TIKET - sudahAda;
  const baris = barisTiket({
    meter: meter.map((m) => ({ id: m.id, penggunaId: m.penggunaId! })),
    teknisiId: teknisi.id,
    jumlah: kurang,
    urutTerpakai,
    acak: acak(BENIH_TIKET),
  });

  for (let i = 0; i < baris.length; i += 500) {
    await prisma.tiket.createMany({
      data: baris.slice(i, i + 500),
      skipDuplicates: true,
    });
  }

  const total = await prisma.tiket.count();
  console.log(`Tiket ditambah ${kurang}: ${sudahAda} menjadi ${total}.`);
}

utama()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
