/**
 * Neraca air: satu sumber hitungan untuk /statistik, /neraca-air, dan /unduh.
 *
 * Ketiganya menjawab pertanyaan yang sama dari sudut berbeda — angka besar di
 * halaman depan, rincian di halaman statistik, dan berkas mentah yang bisa
 * diunduh. Kalau masing-masing menghitung sendiri, ketiganya akan berselisih
 * begitu rentang waktunya diganti, dan orang pertama yang mencocokkannya akan
 * menyimpulkan salah satunya dikarang — tanpa tahu yang mana. Berkas ini ada
 * supaya perselisihan itu tidak mungkin terjadi.
 *
 * Seluruh angkanya dijumlahkan dari tabel `NeracaHarian`. Tidak ada konstanta
 * volume di berkas ini; yang konstan hanyalah PORSI komponen neraca (hasil
 * audit triwulanan, bukan pengukuran harian) dan dua asumsi kependudukan yang
 * diakui terbuka di `META.catatan`.
 */
import { prisma } from "./prisma.js";

/* ── Rentang ─────────────────────────────────────────────────────────── */

/** Rentang yang dilayani. Di luar ini jatuh ke 30 hari. */
export const RENTANG_SAH = [7, 30, 90] as const;

export const rentangSah = (n: number): number =>
  (RENTANG_SAH as readonly number[]).includes(n) ? n : 30;

/* ── Asumsi yang diakui terbuka ──────────────────────────────────────── */

/**
 * Rata-rata jiwa per rumah tangga, acuan BPS.
 *
 * Ini ASUMSI, bukan hasil pendataan per sambungan — dan karena itu ia ikut
 * ditulis di daftar batasan yang tampil di halaman. Mengubah angka ini
 * mengubah seluruh bagian "pemakaian per orang"; jangan disetel diam-diam
 * supaya hasilnya terlihat lebih bagus.
 */
export const JIWA_PER_SAMBUNGAN = 3.9;

/** Kebutuhan pokok air minum, liter/orang/hari. Acuan WHO. */
export const KEBUTUHAN_DASAR_L = 60;

/* ── Tipe jawaban ────────────────────────────────────────────────────── */

export type KelompokKunci = "fisik" | "komersial" | "resmi";

export interface KomponenNeraca {
  kunci: string;
  kelompok: KelompokKunci;
  nama: string;
  catatan: string;
  volumeM3: number;
  /** Porsi terhadap SELURUH kehilangan, bukan terhadap kelompoknya. */
  porsiPct: number;
}

export interface KelompokNeraca {
  kunci: KelompokKunci;
  nama: string;
  ringkas: string;
  volumeM3: number;
  porsiPct: number;
  komponen: KomponenNeraca[];
}

export interface TolokUkur {
  kunci: string;
  nama: string;
  nilaiPct: number;
  sumber: string;
}

export interface TitikBulanan {
  /** `2026-10` — kunci mesin, dipakai di berkas unduhan. */
  bulan: string;
  /** `Okt` atau `Jan 26` — label manusia untuk sumbu grafik. */
  label: string;
  disalurkanM3: number;
  tercatatM3: number;
  kehilanganM3: number;
  nrwPct: number;
}

export interface PemakaianPerOrang {
  jiwaTerlayani: number;
  jiwaPerSambungan: number;
  disalurkanLOrangHari: number;
  tercatatLOrangHari: number;
  kebutuhanDasarLOrangHari: number;
  pemenuhanPct: number;
}

export interface MetaData {
  sumber: string;
  pembaruan: string;
  lisensi: string;
  catatan: string[];
}

export interface NeracaAirPublik {
  rentangHari: number;
  totalDisalurkanM3: number;
  totalTercatatM3: number;
  totalKehilanganM3: number;
  nrwPct: number;
  kelompok: KelompokNeraca[];
  perOrang: PemakaianPerOrang;
  tolokUkur: TolokUkur[];
  bulanan: TitikBulanan[];
  meta: MetaData;
}

/* ── Komponen neraca menurut kerangka IWA ────────────────────────────── */

const KELOMPOK: { kunci: KelompokKunci; nama: string; ringkas: string }[] = [
  {
    kunci: "fisik",
    nama: "Kehilangan fisik",
    ringkas:
      "Air yang benar-benar keluar dari jaringan sebelum sampai ke rumah mana pun. Inilah yang hilang dalam arti harfiah.",
  },
  {
    kunci: "komersial",
    nama: "Kehilangan non-fisik",
    ringkas:
      "Air yang sampai ke pemakainya, tetapi tidak pernah tercatat utuh di meter. Volumenya tidak hilang; catatannya yang hilang.",
  },
  {
    kunci: "resmi",
    nama: "Pemakaian resmi tanpa tagihan",
    ringkas:
      "Air yang memang dipakai untuk merawat jaringan dan menghadapi keadaan darurat. Tercatat sebagai kehilangan, tetapi bukan kebocoran.",
  },
];

/**
 * Porsi tiap komponen terhadap SELURUH kehilangan, dalam persen.
 *
 * Jumlah seluruh `porsi` WAJIB 100 — kalau tidak, rinciannya tidak akan
 * membagi habis kehilangan yang tampil di layar. Dijaga oleh pengujian.
 *
 * Susunannya mengikuti kerangka neraca air IWA dan kisaran yang lazim pada
 * PDAM di Indonesia: kehilangan fisik mendominasi (sekitar enam dari sepuluh
 * meter kubik), kesalahan ukur meter adalah penyumbang non-fisik terbesar, dan
 * pemakaian resmi tanpa tagihan tinggal porsi kecil.
 *
 * Angka ini berasal dari audit neraca air TRIWULANAN, bukan pengukuran harian.
 * Itu sebabnya ia konstan sementara volumenya mengikuti rentang yang dipilih —
 * dan itu pula yang ditulis apa adanya di `META.catatan`.
 */
const KOMPONEN: {
  kunci: string;
  kelompok: KelompokKunci;
  nama: string;
  catatan: string;
  porsi: number;
}[] = [
  {
    kunci: "bocor-distribusi",
    kelompok: "fisik",
    nama: "Kebocoran pipa distribusi",
    catatan: "Pipa induk dan pipa cabang di bawah jalan.",
    porsi: 41,
  },
  {
    kunci: "bocor-dinas",
    kelompok: "fisik",
    nama: "Kebocoran pipa dinas",
    catatan: "Ruas dari pipa cabang sampai meter pelanggan.",
    porsi: 14,
  },
  {
    kunci: "luapan-reservoir",
    kelompok: "fisik",
    nama: "Luapan dan rembesan reservoir",
    catatan: "Tangki, bak pelepas tekan, dan katup penyusunnya.",
    porsi: 7,
  },
  {
    kunci: "salah-ukur-meter",
    kelompok: "komersial",
    nama: "Kesalahan ukur meter pelanggan",
    catatan: "Meter tua membaca lebih rendah dari aliran sebenarnya.",
    porsi: 17,
  },
  {
    kunci: "sambungan-liar",
    kelompok: "komersial",
    nama: "Sambungan tidak tercatat",
    catatan: "Sambungan liar dan pipa yang melewati meter.",
    porsi: 9,
  },
  {
    kunci: "salah-catat",
    kelompok: "komersial",
    nama: "Kesalahan baca dan catat",
    catatan: "Pembacaan yang gagal terkirim atau salah masuk ke tagihan.",
    porsi: 4,
  },
  {
    kunci: "pembilasan",
    kelompok: "resmi",
    nama: "Pembilasan jaringan dan uji mutu",
    catatan: "Air dibuang untuk membersihkan pipa dan mengambil sampel.",
    porsi: 5,
  },
  {
    kunci: "hidran",
    kelompok: "resmi",
    nama: "Hidran dan kebutuhan darurat",
    catatan: "Pemadaman kebakaran dan penyaluran saat gangguan.",
    porsi: 3,
  },
];

/**
 * Membagi `total` menurut `porsi` sehingga hasilnya BULAT dan jumlahnya
 * kembali persis `total`.
 *
 * Pembulatan biasa pada delapan baris sekaligus meleset sampai beberapa meter
 * kubik, dan baris "jumlah" di halaman akan berbeda dari angka besar di
 * atasnya. Metode sisa terbesar membagikan selisihnya kepada baris yang
 * pecahannya paling besar, jadi tidak ada satu meter kubik pun yang menguap
 * atau muncul dari ketiadaan.
 */
export function bagiTepat(total: number, porsi: number[]): number[] {
  const jumlahPorsi = porsi.reduce((a, b) => a + b, 0);
  if (jumlahPorsi <= 0 || total <= 0) return porsi.map(() => 0);

  const mentah = porsi.map((p) => (total * p) / jumlahPorsi);
  const hasil = mentah.map((v) => Math.floor(v));
  let sisa = total - hasil.reduce((a, b) => a + b, 0);

  const urutPecahan = mentah
    .map((v, i) => ({ i, pecahan: v - Math.floor(v) }))
    .sort((a, b) => b.pecahan - a.pecahan);

  for (let k = 0; sisa > 0 && k < urutPecahan.length; k += 1) {
    const i = urutPecahan[k]!.i;
    hasil[i] = (hasil[i] ?? 0) + 1;
    sisa -= 1;
  }
  return hasil;
}

export const persen1 = (bagian: number, dari: number): number =>
  dari > 0 ? Math.round((bagian / dari) * 1000) / 10 : 0;

function kelompokNeraca(totalKehilangan: number): KelompokNeraca[] {
  const volume = bagiTepat(
    totalKehilangan,
    KOMPONEN.map((k) => k.porsi),
  );

  const komponen: KomponenNeraca[] = KOMPONEN.map((k, i) => ({
    kunci: k.kunci,
    kelompok: k.kelompok,
    nama: k.nama,
    catatan: k.catatan,
    volumeM3: volume[i] ?? 0,
    // Porsi DIHITUNG ULANG dari volume yang sudah dibulatkan, bukan disalin
    // dari `k.porsi`. Dengan begitu persen di layar selalu cocok dengan meter
    // kubik di sebelahnya.
    porsiPct: persen1(volume[i] ?? 0, totalKehilangan),
  }));

  return KELOMPOK.map((g) => {
    const isi = komponen.filter((k) => k.kelompok === g.kunci);
    const volumeM3 = isi.reduce((a, k) => a + k.volumeM3, 0);
    return {
      kunci: g.kunci,
      nama: g.nama,
      ringkas: g.ringkas,
      volumeM3,
      porsiPct: persen1(volumeM3, totalKehilangan),
      komponen: isi,
    };
  });
}

/**
 * Pembanding untuk angka NRW. Tanpa ini "21%" tidak berarti apa-apa bagi
 * pembaca yang belum pernah mengurus jaringan air.
 */
const TOLOK_UKUR: TolokUkur[] = [
  {
    kunci: "terbaik",
    nama: "Praktik terbaik internasional",
    nilaiPct: 15,
    sumber: "Kerangka neraca air IWA",
  },
  {
    kunci: "target",
    nama: "Target pemerintah",
    nilaiPct: 20,
    sumber: "Sasaran penyelenggaraan SPAM nasional",
  },
  {
    kunci: "nasional",
    nama: "Rata-rata PDAM nasional",
    nilaiPct: 25,
    sumber: "Titik tengah kisaran 20–30% yang lazim dilaporkan",
  },
];

const NAMA_BULAN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

export const META: MetaData = {
  sumber:
    "Meter induk tiap zona dan meter pelanggan pada jaringan Jernih. Porsi komponen neraca air berasal dari audit neraca air triwulanan.",
  pembaruan:
    "Agregat harian disusun ulang setiap hari pukul 02.00 WIB. Komponen neraca air diperbarui tiap triwulan.",
  lisensi:
    "Bebas dipakai ulang, termasuk untuk tujuan komersial, dengan menyebut Jernih sebagai sumber (CC BY 4.0).",
  catatan: [
    "Meter pelanggan dibaca harian sedangkan meter induk tiap 15 menit; selisih waktu baca membuat angka satu hari bisa bergeser sekitar 1,5 poin. Yang stabil adalah rata-rata mingguan ke atas.",
    "Porsi komponen neraca air berasal dari audit triwulanan, bukan pengukuran harian. Yang berubah mengikuti rentang yang dipilih adalah volumenya, bukan porsinya.",
    "Jumlah jiwa terlayani adalah perkiraan dari 3,9 jiwa per sambungan (rata-rata rumah tangga nasional), bukan hasil pendataan per rumah.",
    "Pemakaian per orang hanya menghitung air PDAM yang tercatat di meter. Sumur, mata air, dan air kemasan tidak masuk hitungan.",
    "Zona yang meter induknya sedang diperbaiki dihitung memakai estimasi, dan NRW zona tersebut punya ketidakpastian lebih lebar.",
    "Angka pada halaman ini belum diaudit pihak ketiga.",
  ],
};

/* ── Pembacaan dari basis data ───────────────────────────────────────── */

/**
 * Tanggal murni (UTC tengah malam) sejumlah hari ke belakang.
 *
 * Kolom `NeracaHarian.tanggal` bertipe `DATE`, jadi pembandingnya harus
 * tanggal murni juga. Memakai `new Date(Date.now() - n*86400000)` apa adanya
 * menyisipkan jam, dan baris paling awal bisa ikut tersaring keluar tergantung
 * jam berapa permintaan datang — rentang 30 hari lalu kadang berisi 29 baris.
 */
function tanggalMurni(geserHari: number): Date {
  const d = new Date(Date.now() - geserHari * 86_400_000);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

const liter = (d: { toNumber(): number } | null | undefined): number =>
  d?.toNumber() ?? 0;

const keM3 = (l: number): number => Math.round(l / 1000);

export interface RingkasNeraca {
  rentangHari: number;
  disalurkanM3: number;
  tercatatM3: number;
  kehilanganM3: number;
  nrwPct: number;
}

/** Total jaringan untuk rentang tertentu. Dipakai /statistik dan /neraca-air. */
export async function ringkasNeraca(hari: number): Promise<RingkasNeraca> {
  const mulai = tanggalMurni(hari - 1);
  const agg = await prisma.neracaHarian.aggregate({
    where: { tanggal: { gte: mulai } },
    _sum: { volumeIndukL: true, volumeTercatatL: true },
  });

  const disalurkanM3 = keM3(liter(agg._sum.volumeIndukL));
  const tercatatM3 = keM3(liter(agg._sum.volumeTercatatL));
  const kehilanganM3 = disalurkanM3 - tercatatM3;

  return {
    rentangHari: hari,
    disalurkanM3,
    tercatatM3,
    kehilanganM3,
    nrwPct: persen1(kehilanganM3, disalurkanM3),
  };
}

export interface BarisHarian {
  tanggal: string;
  disalurkanM3: number;
  tercatatM3: number;
  kehilanganM3: number;
  nrwPct: number;
}

/**
 * Deret harian untuk rentang tertentu, seluruh zona dijumlahkan.
 *
 * Hari tanpa catatan tetap muncul bernilai 0, bukan dilewati: celah di sumbu
 * waktu membuat grafik berbohong soal bentuk trennya.
 */
export async function deretHarian(hari: number): Promise<BarisHarian[]> {
  const mulai = tanggalMurni(hari - 1);
  const baris = await prisma.neracaHarian.groupBy({
    by: ["tanggal"],
    where: { tanggal: { gte: mulai } },
    _sum: { volumeIndukL: true, volumeTercatatL: true },
  });

  const peta = new Map(
    baris.map((b) => [
      b.tanggal.toISOString().slice(0, 10),
      {
        induk: liter(b._sum.volumeIndukL),
        tercatat: liter(b._sum.volumeTercatatL),
      },
    ]),
  );

  return Array.from({ length: hari }, (_, i) => {
    const kunci = tanggalMurni(hari - 1 - i).toISOString().slice(0, 10);
    const v = peta.get(kunci) ?? { induk: 0, tercatat: 0 };
    const disalurkanM3 = keM3(v.induk);
    const tercatatM3 = keM3(v.tercatat);
    const kehilanganM3 = disalurkanM3 - tercatatM3;
    return {
      tanggal: kunci,
      disalurkanM3,
      tercatatM3,
      kehilanganM3,
      nrwPct: persen1(kehilanganM3, disalurkanM3),
    };
  });
}

export interface BarisZona {
  zonaId: string;
  nama: string;
  disalurkanM3: number;
  tercatatM3: number;
  nrwPct: number;
}

/** Rincian per zona untuk rentang tertentu. */
export async function perZonaNeraca(hari: number): Promise<BarisZona[]> {
  const mulai = tanggalMurni(hari - 1);
  const [zona, baris] = await Promise.all([
    prisma.zona.findMany({ select: { id: true, nama: true } }),
    prisma.neracaHarian.groupBy({
      by: ["zonaId"],
      where: { tanggal: { gte: mulai } },
      _sum: { volumeIndukL: true, volumeTercatatL: true },
    }),
  ]);

  const peta = new Map(baris.map((b) => [b.zonaId, b._sum]));

  return zona
    .map((z) => {
      const s = peta.get(z.id);
      const disalurkanM3 = keM3(liter(s?.volumeIndukL));
      const tercatatM3 = keM3(liter(s?.volumeTercatatL));
      return {
        zonaId: z.id,
        nama: z.nama,
        disalurkanM3,
        tercatatM3,
        nrwPct: persen1(disalurkanM3 - tercatatM3, disalurkanM3),
      };
    })
    .sort((a, b) => a.nama.localeCompare(b.nama, "id"));
}

/**
 * Dua belas bulan terakhir, bulan berjalan di ujung kanan.
 *
 * Rentang 7/30/90 hari menjawab "sekarang di posisi mana"; hanya deret
 * sepanjang ini yang menjawab "arahnya ke mana". Sengaja TIDAK bergantung pada
 * rentang yang dipilih pembaca: arah setahun bukan sesuatu yang berubah karena
 * seseorang menekan tombol 7 hari.
 *
 * Bulan yang datanya belum lengkap tetap ditampilkan apa adanya — termasuk
 * bulan berjalan. Menyembunyikannya membuat grafik berakhir di bulan lalu dan
 * pembaca menyangka pelaporannya tertinggal sebulan.
 */
export async function trenBulanan(): Promise<TitikBulanan[]> {
  const kini = new Date();
  const awal = new Date(Date.UTC(kini.getFullYear(), kini.getMonth() - 11, 1));

  const baris = await prisma.neracaHarian.findMany({
    where: { tanggal: { gte: awal } },
    select: { tanggal: true, volumeIndukL: true, volumeTercatatL: true },
  });

  const perBulan = new Map<string, { induk: number; tercatat: number }>();
  for (const b of baris) {
    const kunci = b.tanggal.toISOString().slice(0, 7);
    const akum = perBulan.get(kunci) ?? { induk: 0, tercatat: 0 };
    akum.induk += liter(b.volumeIndukL);
    akum.tercatat += liter(b.volumeTercatatL);
    perBulan.set(kunci, akum);
  }

  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(kini.getFullYear(), kini.getMonth() - (11 - i), 1));
    const bulan = d.toISOString().slice(0, 7);
    const v = perBulan.get(bulan) ?? { induk: 0, tercatat: 0 };
    const disalurkanM3 = keM3(v.induk);
    const tercatatM3 = keM3(v.tercatat);
    const kehilanganM3 = disalurkanM3 - tercatatM3;
    return {
      bulan,
      // Januari membawa tahunnya: tanpa itu deret 12 bulan yang melintasi
      // pergantian tahun terbaca seolah semuanya di tahun yang sama.
      label:
        d.getUTCMonth() === 0
          ? `${NAMA_BULAN[0]} ${String(d.getUTCFullYear()).slice(2)}`
          : (NAMA_BULAN[d.getUTCMonth()] ?? bulan),
      disalurkanM3,
      tercatatM3,
      kehilanganM3,
      // Diturunkan dari volume yang SUDAH dibulatkan, supaya grafik dan berkas
      // unduhan tidak pernah berbeda di angka di belakang koma.
      nrwPct: persen1(kehilanganM3, disalurkanM3),
    };
  });
}

/** Rakitan lengkap untuk `GET /api/publik/neraca-air`. */
export async function neracaAir(hariMasuk: number): Promise<NeracaAirPublik> {
  const hari = rentangSah(hariMasuk);

  const [ringkas, bulanan, pelangganTerlayani] = await Promise.all([
    ringkasNeraca(hari),
    trenBulanan(),
    prisma.pengguna.count({ where: { peran: "WARGA" } }),
  ]);

  const jiwaTerlayani = Math.round(pelangganTerlayani * JIWA_PER_SAMBUNGAN);
  const perOrangHari = (volumeM3: number) =>
    jiwaTerlayani > 0 && hari > 0
      ? Math.round(((volumeM3 * 1000) / jiwaTerlayani / hari) * 10) / 10
      : 0;

  const tercatatLOrangHari = perOrangHari(ringkas.tercatatM3);

  return {
    rentangHari: hari,
    totalDisalurkanM3: ringkas.disalurkanM3,
    totalTercatatM3: ringkas.tercatatM3,
    totalKehilanganM3: ringkas.kehilanganM3,
    nrwPct: ringkas.nrwPct,
    kelompok: kelompokNeraca(ringkas.kehilanganM3),
    perOrang: {
      jiwaTerlayani,
      jiwaPerSambungan: JIWA_PER_SAMBUNGAN,
      disalurkanLOrangHari: perOrangHari(ringkas.disalurkanM3),
      tercatatLOrangHari,
      kebutuhanDasarLOrangHari: KEBUTUHAN_DASAR_L,
      pemenuhanPct: persen1(tercatatLOrangHari, KEBUTUHAN_DASAR_L),
    },
    tolokUkur: TOLOK_UKUR,
    bulanan,
    meta: META,
  };
}
