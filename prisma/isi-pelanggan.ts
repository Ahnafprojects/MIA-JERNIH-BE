/**
 * Menambah pelanggan dan meter di basis data yang SUDAH berisi data.
 *
 * Alasannya sama dengan `isi-neraca.ts` dan `isi-tiket.ts`: seed mengosongkan
 * seluruh tabel lebih dulu, dan menjalankannya di server akan menghapus akun,
 * transaksi, serta pengaduan yang sudah ada.
 *
 * Masalah yang diselesaikan: dengan 120 sambungan tersebar di empat zona
 * seluas Bandung Raya, peta jaringan di konsol terbaca hampir kosong.
 *
 * AMAN DIJALANKAN BERULANG. Berhenti tanpa menulis apa pun begitu jumlah
 * meter sudah mencapai target, dan penomoran id, node, serial, serta email
 * selalu melanjutkan yang sudah terpakai.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { acak } from "./neraca-demo.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Harus sama dengan `JUMLAH_PELANGGAN` di `seed.ts`. */
const TARGET_METER = 420;

/** Benih tetap: menjalankan ulang menghasilkan sambungan yang sama. */
const BENIH = 20261101;

/** Titik pusat tiap zona, dipakai menyebar koordinat di sekitarnya. */
const PUSAT_ZONA: Record<string, [number, number]> = {
  "Bandung Timur": [107.682, -6.928],
  Cileunyi: [107.784, -6.936],
  Cimahi: [107.527, -6.874],
  Sumedang: [107.932, -6.838],
};

const DEPAN = [
  "Budi", "Siti", "Agus", "Dewi", "Rudi", "Rina", "Joko", "Maya",
  "Hendra", "Lestari", "Bambang", "Indah", "Yusuf", "Fitri", "Dian",
];
const BELAKANG = [
  "Hartono", "Wijaya", "Setiawan", "Nugroho", "Puspita", "Santoso",
  "Permana", "Rahayu", "Kusuma", "Hidayat", "Maulana", "Safitri",
];

const bulat = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function utama(): Promise<void> {
  const sudahAda = await prisma.meter.count();
  if (sudahAda >= TARGET_METER) {
    console.log(`Meter sudah ${sudahAda} (target ${TARGET_METER}) — tidak diubah.`);
    return;
  }

  const [zona, golongan, contohPengguna] = await Promise.all([
    prisma.zona.findMany({ select: { id: true, nama: true } }),
    prisma.golongan.findMany({ select: { id: true } }),
    prisma.pengguna.findFirst({ where: { peran: "WARGA" }, select: { kataSandiHash: true } }),
  ]);

  if (zona.length === 0 || golongan.length === 0) {
    console.log("Zona atau golongan belum ada — seed dasar harus jalan lebih dulu.");
    return;
  }
  if (!contohPengguna) {
    console.log("Belum ada pengguna warga — tidak ada contoh kata sandi untuk disalin.");
    return;
  }

  /*
   * Penomoran melanjutkan yang sudah terpakai.
   *
   * `id`, `node`, dan `serial` seluruhnya unik di skema. Memulai dari nol
   * akan bertabrakan dengan 120 sambungan yang sudah ada, dan seluruh
   * penulisan gagal di tengah jalan.
   */
  const meterAda = await prisma.meter.findMany({ select: { serial: true } });
  let urut = 0;
  for (const { serial } of meterAda) {
    const n = Number(/^JRN-(\d+)$/.exec(serial)?.[1]);
    if (Number.isFinite(n) && n - 10000 >= urut) urut = n - 10000 + 1;
  }

  const r = acak(BENIH);
  const pilih = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const kini = Date.now();
  const JAM = 3_600_000;

  const kurang = TARGET_METER - sudahAda;
  const penggunaBaru = [];
  const meterBaru = [];

  for (let n = 0; n < kurang; n++) {
    const i = urut + n;
    const z = pilih(zona);
    const pusat = PUSAT_ZONA[z.nama] ?? [107.6, -6.9];

    const pid = `usr_t_${String(i).padStart(5, "0")}`;
    const mid = `PT${String(i).padStart(4, "0")}`;

    const daring = r() > 0.08;
    const saklarOn = r() > 0.05;
    const v = r();
    const saldoL = bulat(v * v * 8500);
    const relayOn = saklarOn && saldoL > 0 && daring;
    const debit = relayOn && r() > 0.5 ? bulat(1.2 + r() * 12.0, 1) : 0;

    const sudut = r() * Math.PI * 2;
    const jarak = Math.pow(r(), 1.6) * 0.04;
    const adaKoordinat = r() > 0.05;

    penggunaBaru.push({
      id: pid,
      nama: `${pilih(DEPAN)} ${pilih(BELAKANG)}`,
      email: `warga_t_${i}@jernih.id`,
      kataSandiHash: contohPengguna.kataSandiHash,
      peran: "WARGA" as const,
      zonaId: z.id,
      golonganId: pilih(golongan).id,
      emailTerverifikasiPada: new Date(kini - Math.floor(r() * 300) * 24 * JAM),
      aktif: r() > 0.04,
      akunDemo: true,
    });

    meterBaru.push({
      id: mid,
      node: `NODE.T${String(i).padStart(5, "0")}`,
      serial: `JRN-${String(10000 + i)}`,
      alamat: `Jl. Melati No. ${1 + (i % 99)}`,
      zonaId: z.id,
      penggunaId: pid,
      lat: adaKoordinat ? bulat(pusat[1] + Math.sin(sudut) * jarak * 0.78, 5) : null,
      lng: adaKoordinat ? bulat(pusat[0] + Math.cos(sudut) * jarak, 5) : null,
      saldoL,
      volumeTotalL: bulat(2000 + r() * 45000),
      debitLpm: debit,
      relay: relayOn ? ("AKTIF" as const) : ("NONAKTIF" as const),
      saklarOn,
      daring,
      terakhirTerlihat: new Date(kini - Math.floor(r() * (daring ? 120 : 86400)) * 1000),
      versiFirmware: pilih(["2.1.4", "2.1.3", "2.0.8"]),
      rssi: -(50 + Math.floor(r() * 40)),
    });
  }

  for (let i = 0; i < penggunaBaru.length; i += 500) {
    await prisma.pengguna.createMany({
      data: penggunaBaru.slice(i, i + 500),
      skipDuplicates: true,
    });
  }
  for (let i = 0; i < meterBaru.length; i += 500) {
    await prisma.meter.createMany({
      data: meterBaru.slice(i, i + 500),
      skipDuplicates: true,
    });
  }

  const total = await prisma.meter.count();
  console.log(`Sambungan ditambah ${kurang}: ${sudahAda} menjadi ${total}.`);
}

utama()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
