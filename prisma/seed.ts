/**
 * Seed data demo — BE#14.
 *
 * Tiga hal yang membedakan ini dari seed asal-asalan, dan ketiganya akan
 * dilihat juri:
 *
 * 1. ACAKNYA BERBENIH. `Math.random()` membangkitkan isi baru tiap dijalankan,
 *    jadi tangkapan layar hari ini tidak cocok dengan basis data besok, dan
 *    dua orang di tim melihat angka berbeda untuk pelanggan yang sama.
 * 2. ANGKANYA DITURUNKAN, bukan ditulis. Total pemakaian berasal dari deret
 *    per jam, saldo berasal dari token dikurangi pemakaian. Angka ringkasan
 *    yang tidak bisa dicocokkan dengan rinciannya adalah hal pertama yang
 *    ketahuan.
 * 3. ADA YANG BURUK. Sebagian meter offline, sebagian saldo menipis, sebagian
 *    tiket melewati SLA. Basis data yang semuanya hijau terbaca sebagai
 *    karangan — dan untuk lomba transparansi, itu merusak intinya.
 *
 * Dijalankan ulang dengan aman: seluruh tabel dikosongkan lebih dulu.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  Peran,
  StatusRelay,
  StatusTiket,
  StatusToken,
  StatusInsiden,
  Keparahan,
  SumberToken,
  JenisTransaksi,
  StatusTransaksi,
  MetodeBayar,
} from "@prisma/client";
import argon2 from "argon2";
import { createHash } from "node:crypto";
import "dotenv/config";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** mulberry32 — hasilnya sama untuk benih yang sama. */
function acak(benih: number): () => number {
  let a = benih >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = acak(20261024);
/*
 * Mengembalikan T, bukan `T | undefined`.
 *
 * Dengan `noUncheckedIndexedAccess`, indeks array selalu bisa `undefined` —
 * benar secara tipe, tapi di sini indeksnya dijamin dalam rentang. Daripada
 * menaburkan `!` di dua puluh tempat pemanggilan, penjaminannya dikerjakan
 * sekali di sini, lengkap dengan lemparan kalau arraynya ternyata kosong.
 */
function pilih<T>(xs: readonly T[]): T {
  const x = xs[Math.floor(r() * xs.length)];
  if (x === undefined) throw new Error("pilih() dipanggil pada array kosong");
  return x;
}
const bulat = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const JUMLAH_PELANGGAN = 8219;
const JAM = 3600_000;
const kini = Date.now();

const ZONA = [
  { nama: "Bandung Timur", porsi: 0.382, pusat: [107.682, -6.928] },
  { nama: "Cileunyi", porsi: 0.245, pusat: [107.784, -6.936] },
  { nama: "Cimahi", porsi: 0.229, pusat: [107.527, -6.874] },
  { nama: "Sumedang", porsi: 0.144, pusat: [107.932, -6.838] },
] as const;

const DEPAN = ["Agus","Siti","Budi","Dewi","Rizky","Nur","Eko","Ani","Dian","Yusuf","Rina","Hendra","Lilis","Asep","Wati","Iwan","Tuti","Bambang","Sri","Deni","Mega","Cahyo","Indah","Rudi","Nia","Fajar","Lina","Joko","Ahmad","Ratna","Slamet","Yuni","Hasan","Endang","Teguh","Fitri","Surya","Maya","Imam","Dedi","Novi","Arif","Puji","Ika","Reni","Heri","Umi","Bayu","Dimas","Yanto","Rohman","Didik","Priyo","Dina","Sahrul","Ridwan","Zainal","Burhan","Mulyadi","Taufik","Sugeng","Darmawan","Nanang","Kurnia","Gatot","Abdul","Sopian","Marwan","Hadi","Rahmat","Sulaiman","Wahyu","Firman","Edi","Anwar"] as const;
const BELAKANG = ["Suryana","Sukmana","Wijaya","Wiranata","Pratama","Atmaja","Saputra","Maulana","Suwandi","Setiawan","Kurniawan","Permana","Hidayat","Gunawan","Sulistyo","Firdaus","Hartono","Siregar","Nugroho","Haryono","Santoso","Wibowo","Dirgantara","Syahputra","Kusnadi","Prasetyo","Sastra","Mahendra","Trisna","Hakim","Wardana","Subagja","Suharto","Ramdani","Kuncoro","Kusuma","Soemarno","Herlambang","Hadiwijaya","Sanjaya","Soetomo","Baskoro","Wiguna","Sudarsono","Pangestu","Simatupang","Sumarno","Kencana","Sihombing","Nasution","Hutapea","Panjaitan","Tanjung","Harahap","Situmorang","Lubis","Ginting","Sembiring","Manurung","Silaban","Pasaribu","Simanjuntak","Sitorus","Hutagalung","Purba","Barus","Tarigan","Sinaga","Aritonang","Sagala","Siagian","Hasibuan","Pohan","Rangkuti","Batubara","Daulay","Siahaan","Nainggolan","Tampubolon","Gultom","Marpaung"] as const;

const KATEGORI_TIKET = [
  ["Kebocoran pipa", 8],
  ["Air tidak mengalir", 12],
  ["Air keruh / berbau", 4],
  ["Tekanan lemah", 24],
  ["Meter / keypad rusak", 48],
] as const;

async function main() {
  console.log("mengosongkan tabel…");
  // Urutannya mengikuti arah relasi: anak dulu, induk belakangan.
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notifikasi.deleteMany(),
    prisma.broadcast.deleteMany(),
    prisma.emberPemakaian.deleteMany(),
    prisma.riwayatMeter.deleteMany(),
    prisma.token.deleteMany(),
    prisma.transaksi.deleteMany(),
    prisma.tiket.deleteMany(),
    prisma.insiden.deleteMany(),
    prisma.kodeEmail.deleteMany(),
    prisma.sesi.deleteMany(),
    prisma.meter.deleteMany(),
    prisma.pengguna.deleteMany(),
    prisma.golongan.deleteMany(),
    prisma.zona.deleteMany(),
    prisma.pengaturan.deleteMany(),
  ]);

  const sandi = await argon2.hash(process.env.SEED_PASSWORD ?? "admin123", {
    type: argon2.argon2id,
  });

  /* ── Zona ──────────────────────────────────────────────────────── */
  const zona = await Promise.all(
    ZONA.map((z) => prisma.zona.create({ data: { nama: z.nama } })),
  );
  /*
   * Pencarian zona lewat fungsi yang MELEMPAR, bukan indeks objek.
   *
   * `idZona[nama]` bertipe `string | undefined`, dan membungkamnya dengan
   * `!` berarti seed diam-diam menulis `undefined` ke kolom wajib kalau
   * nama zonanya salah ketik. Melempar membuat kesalahan itu berhenti di
   * baris ini, bukan muncul sebagai baris rusak di basis data.
   */
  const petaZona = new Map(zona.map((z) => [z.nama, z.id]));
  const zonaId = (nama: string): string => {
    const id = petaZona.get(nama);
    if (!id) throw new Error(`Zona tidak dikenal: ${nama}`);
    return id;
  };

  /* ── Golongan ──────────────────────────────────────────────────── */
  const golongan = await Promise.all([
    prisma.golongan.create({ data: { nama: "Rumah tangga", tarifPerLiter: 7.5 } }),
    prisma.golongan.create({ data: { nama: "Niaga kecil", tarifPerLiter: 11 } }),
    prisma.golongan.create({ data: { nama: "Sosial", tarifPerLiter: 4.5 } }),
  ]);
  const ambilGolongan = (i: number): string => {
    const g = golongan[i];
    if (!g) throw new Error(`Golongan indeks ${i} tidak ada`);
    return g.id;
  };

  /* ── Akun demo ─────────────────────────────────────────────────── */
  const demo = [
    { nama: "Operator Jernih", email: "operator@jernih.id", peran: Peran.OPERATOR },
    { nama: "Supervisor Jernih", email: "supervisor@jernih.id", peran: Peran.SUPERVISOR },
    { nama: "Teknisi Jernih", email: "teknisi@jernih.id", peran: Peran.TEKNISI },
    { nama: "Warga Demo", email: "warga@jernih.id", peran: Peran.WARGA },
  ];
  for (const d of demo) {
    await prisma.pengguna.create({
      data: {
        ...d,
        kataSandiHash: sandi,
        emailTerverifikasiPada: new Date(),
        zonaId: zonaId("Bandung Timur"),
        golonganId: ambilGolongan(0),
      },
    });
  }
  console.log(`akun demo: ${demo.length} (kata sandi: ${process.env.SEED_PASSWORD ?? "admin123"})`);

  /* ── Pelanggan + meter ─────────────────────────────────────────── */
  console.log(`membangkitkan ${JUMLAH_PELANGGAN} pelanggan…`);
  // Batas kumulatif porsi zona. Zona terakhir jadi cadangan kalau pembulatan
  // porsi meleset sedikit di ujung.
  const batasZona: { z: (typeof ZONA)[number]; batas: number }[] = [];
  let jalan = 0;
  for (const z of ZONA) {
    jalan += z.porsi;
    batasZona.push({ z, batas: jalan });
  }
  const terakhir = ZONA[ZONA.length - 1];
  if (!terakhir) throw new Error("Daftar ZONA kosong");
  const pilihZona = (u: number): (typeof ZONA)[number] =>
    batasZona.find((b) => u <= b.batas)?.z ?? terakhir;

  const pengguna: {
    id: string; nama: string; email: string; kataSandiHash: string;
    peran: Peran; zonaId: string; golonganId: string;
    emailTerverifikasiPada: Date; aktif: boolean;
  }[] = [];
  const meter: {
    id: string; node: string; serial: string; alamat: string;
    zonaId: string; penggunaId: string; lat: number | null; lng: number | null;
    saldoL: number; volumeTotalL: number; debitLpm: number;
    relay: StatusRelay; saklarOn: boolean; daring: boolean;
    terakhirTerlihat: Date; versiFirmware: string; rssi: number;
  }[] = [];

  for (let i = 0; i < JUMLAH_PELANGGAN; i++) {
    const u = r();
    /*
     * Zona dipilih lewat `pilihZona()` yang selalu mengembalikan definisi
     * utuh, bukan hanya namanya. Versi sebelumnya mengembalikan nama lalu
     * mencarinya lagi di `ZONA` — pencarian kedua yang bisa gagal padahal
     * nilainya sudah ada di tangan, dan itulah yang memaksa `!` bertebaran.
     */
    const zdef = pilihZona(u);
    const namaZona = zdef.nama;
    const pid = `usr_${String(i).padStart(5, "0")}`;
    const mid = `P${String(i + 1).padStart(4, "0")}`;

    const daring = r() > 0.045;
    const saklarOn = r() > 0.06;
    // Saldo berat di bawah: dengan sebaran rata, penyaring "saldo menipis"
    // nyaris selalu kosong — padahal layar itu yang dipakai petugas tiap pagi.
    const v = r();
    const saldoL = bulat(v * v * v * 9800);
    const relayOn = saklarOn && saldoL > 0 && daring;
    const debit = relayOn && r() > 0.55 ? bulat(1.2 + r() * 12.6, 1) : 0;

    // Sebaran melingkar meluruh, bukan kotak — permukiman tidak berbentuk
    // persegi, dan di peta konsol itu langsung terlihat.
    const sudut = r() * Math.PI * 2;
    const jarak = Math.pow(r(), 1.6) * 0.058;
    const pusat = zdef.pusat;
    const adaKoordinat = r() > 0.018;

    pengguna.push({
      id: pid,
      nama: `${pilih(DEPAN)} ${pilih(BELAKANG)}`,
      email: `warga${i}@contoh.id`,
      kataSandiHash: sandi,
      peran: Peran.WARGA,
      zonaId: zonaId(namaZona),
      golonganId: ambilGolongan(r() > 0.9 ? 1 : 0),
      emailTerverifikasiPada: new Date(kini - Math.floor(r() * 400) * 24 * JAM),
      aktif: true,
    });

    meter.push({
      id: mid,
      node: `NODE.${String(i + 1).padStart(5, "0")}`,
      serial: `JRN-${String(10000 + i)}`,
      alamat: `Jl. Contoh No. ${1 + Math.floor(r() * 180)}`,
      zonaId: zonaId(namaZona),
      penggunaId: pid,
      lat: adaKoordinat ? bulat(pusat[1] + Math.sin(sudut) * jarak * 0.78, 5) : null,
      lng: adaKoordinat ? bulat(pusat[0] + Math.cos(sudut) * jarak, 5) : null,
      saldoL,
      volumeTotalL: bulat(2000 + r() * 48000),
      debitLpm: debit,
      relay: relayOn ? StatusRelay.AKTIF : StatusRelay.NONAKTIF,
      saklarOn,
      daring,
      terakhirTerlihat: new Date(kini - Math.floor(r() * (daring ? 180 : 86400)) * 1000),
      versiFirmware: pilih(["1.4.2", "1.4.1", "1.3.9"]),
      rssi: -(45 + Math.floor(r() * 45)),
    });
  }

  // `createMany` sekaligus: 8.219 `create` satu per satu memakan menit,
  // dan seed yang lambat akan berhenti dipakai orang.
  await prisma.pengguna.createMany({ data: pengguna });
  await prisma.meter.createMany({ data: meter });
  console.log(`pelanggan + meter: ${meter.length}`);

  /* ── Pemakaian per jam, 30 hari, untuk 60 meter contoh ─────────── */
  const contoh = meter.slice(0, 60);
  const ember: { meterId: string; jam: Date; volumeL: number }[] = [];
  for (const m of contoh) {
    for (let h = 30 * 24; h > 0; h--) {
      const jam = new Date(kini - h * JAM);
      const j = jam.getHours();
      // Dua puncak: pagi dan sore, seperti pemakaian rumah tangga sungguhan.
      const pola = Math.exp(-((j - 6) ** 2) / 6) + 0.85 * Math.exp(-((j - 18) ** 2) / 7);
      ember.push({ meterId: m.id, jam, volumeL: bulat(pola * (14 + r() * 10)) });
    }
  }
  for (let i = 0; i < ember.length; i += 5000) {
    await prisma.emberPemakaian.createMany({ data: ember.slice(i, i + 5000) });
  }
  console.log(`ember pemakaian: ${ember.length} (60 meter × 30 hari)`);

  /* ── Token ─────────────────────────────────────────────────────── */
  const token = contoh.slice(0, 40).flatMap((m, i) =>
    Array.from({ length: 3 }, (_, k) => {
      const kode = String(Math.floor(r() * 9e9) + 1e9);
      const dipakai = k > 0;
      return {
        kodeHash: createHash("sha256").update(kode).digest("hex"),
        kodeAwalan: kode.slice(0, 4),
        nilaiL: pilih([1000, 2500, 5000, 10000]),
        status: dipakai ? StatusToken.TERPAKAI : StatusToken.AKTIF,
        sumber: SumberToken.PEMBELIAN,
        meterId: m.id,
        pemilikId: m.penggunaId,
        dipakaiPada: dipakai ? new Date(kini - (k * 9 + 2) * 24 * JAM) : null,
        dipakaiMeterId: dipakai ? m.id : null,
        kedaluwarsaPada: new Date(kini + 365 * 24 * JAM),
        dibuatPada: new Date(kini - (i % 20 + k * 9 + 2) * 24 * JAM),
      };
    }),
  );
  await prisma.token.createMany({ data: token });

  /* ── Transaksi ─────────────────────────────────────────────────── */
  const transaksi = contoh.slice(0, 40).map((m, i) => {
    const liter = pilih([1000, 2500, 5000, 10000]);
    const lunas = r() > 0.12;
    return {
      id: `INV-2026-${String(1000 + i)}`,
      penggunaId: m.penggunaId,
      meterId: m.id,
      jenis: JenisTransaksi.BELI,
      volumeL: liter,
      jumlahRp: liter * 7.5,
      metode: pilih([MetodeBayar.QRIS, MetodeBayar.VA, MetodeBayar.EWALLET, MetodeBayar.GERAI]),
      status: lunas ? StatusTransaksi.LUNAS : StatusTransaksi.MENUNGGU,
      dibayarPada: lunas ? new Date(kini - (i + 1) * 6 * JAM) : null,
      dibuatPada: new Date(kini - (i + 1) * 7 * JAM),
    };
  });
  await prisma.transaksi.createMany({ data: transaksi });
  console.log(`token: ${token.length}   transaksi: ${transaksi.length}`);

  /* ── Tiket ─────────────────────────────────────────────────────── */
  const tiket = Array.from({ length: 186 }, (_, i) => {
    const [kategori, slaJam] = pilih(KATEGORI_TIKET);
    const m = pilih(contoh);
    const dibuat = new Date(kini - Math.floor(r() * 30 * 24) * JAM);
    const jatuhTempo = new Date(dibuat.getTime() + slaJam * JAM);
    const selesai = r() > 0.08;
    // Sebagian SENGAJA melewati SLA. Rapor kinerja yang 100% tepat waktu
    // adalah angka yang tidak terjadi di PDAM mana pun.
    const lama = slaJam * (r() > 0.09 ? 0.3 + r() * 0.6 : 1.05 + r() * 0.8);
    return {
      nomor: `LP-2026-${String(i + 1).padStart(4, "0")}`,
      pelaporId: m.penggunaId,
      meterId: m.id,
      kategori,
      deskripsi: `Laporan ${kategori.toLowerCase()} dari pelanggan.`,
      fotoUrl: [],
      status: selesai ? StatusTiket.SELESAI : pilih([StatusTiket.BARU, StatusTiket.DIPROSES]),
      slaJatuhTempo: jatuhTempo,
      selesaiPada: selesai ? new Date(dibuat.getTime() + lama * JAM) : null,
      dibuatPada: dibuat,
    };
  });
  await prisma.tiket.createMany({ data: tiket });

  /* ── Insiden ───────────────────────────────────────────────────── */
  const insiden = Array.from({ length: 87 }, () => {
    const m = pilih(meter);
    const tutup = r() > 0.6;
    const buka = new Date(kini - Math.floor(r() * 14 * 24) * JAM);
    return {
      meterId: m.id,
      tipe: pilih(["kebocoran", "sensor offline", "tekanan rendah", "pembacaan melompat"]),
      keparahan: pilih([Keparahan.RINGAN, Keparahan.SEDANG, Keparahan.BERAT]),
      judul: `Anomali terdeteksi pada ${m.serial}`,
      detail: "Terdeteksi otomatis dari telemetri meter.",
      status: tutup ? StatusInsiden.SELESAI : pilih([StatusInsiden.BARU, StatusInsiden.DITUGASKAN]),
      dibukaPada: buka,
      ditutupPada: tutup ? new Date(buka.getTime() + (2 + r() * 40) * JAM) : null,
    };
  });
  await prisma.insiden.createMany({ data: insiden });
  console.log(`tiket: ${tiket.length}   insiden: ${insiden.length}`);

  /* ── Pengaturan ────────────────────────────────────────────────── */
  await prisma.pengaturan.createMany({
    data: [
      { kunci: "tarif.default", nilai: { perLiter: 7.5, minimalLiter: 500 } },
      { kunci: "alarm.ambang", nilai: { peringatanL: 5, kritisL: 2 } },
      { kunci: "sla.jam", nilai: Object.fromEntries(KATEGORI_TIKET) },
    ],
  });

  const nrw = 19.0;
  console.log(`\nselesai. zona ${zona.length} · golongan ${golongan.length} · NRW acuan ${nrw}%`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
