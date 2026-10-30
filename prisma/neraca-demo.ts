/**
 * Pembangkit bacaan meter induk untuk basis data peragaan.
 *
 * Dipakai DUA pemanggil yang tidak boleh berselisih:
 *
 * - `prisma/seed.ts`      — menyusun ulang seluruh basis data dari nol.
 * - `prisma/isi-neraca.ts` — mengisi tabel yang masih kosong di server, tanpa
 *                            menyentuh data lain.
 *
 * Kalau keduanya memakai rumus sendiri-sendiri, basis data lokal dan basis
 * data produksi akan memperlihatkan angka kehilangan air yang berbeda untuk
 * sistem yang sama — dan tidak ada yang akan tahu mana yang benar.
 *
 * Nilainya data peragaan. Yang BUKAN peragaan adalah tempatnya: ia tersimpan
 * di basis data, dan API hanya menjumlahkannya. Tidak ada angka yang dikarang
 * saat permintaan masuk.
 */

/** mulberry32 — hasilnya sama untuk benih yang sama. */
export function acak(benih: number): () => number {
  let a = benih >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Benih tetap: seed ulang menghasilkan basis data yang sama persis. */
export const BENIH_NERACA = 20261030;

/**
 * 400 hari, bukan 90.
 *
 * Tren 12 bulan di halaman statistik harus dijawab dari tabel yang sama dengan
 * rentang 7/30/90 hari. Kalau tren disusun dari rumus terpisah, jumlah 30 hari
 * terakhirnya tidak akan cocok dengan bulan berjalan di grafik — dan
 * ketidakcocokan itu persis yang dicari orang pada halaman yang menjanjikan
 * transparansi.
 */
export const HARI_NERACA = 400;

/** Porsi tiap zona terhadap produksi jaringan. Jumlahnya 1. */
export const PORSI_ZONA: Record<string, number> = {
  "Bandung Timur": 0.382,
  Cileunyi: 0.245,
  Cimahi: 0.229,
  Sumedang: 0.144,
};

/**
 * Watak tiap zona terhadap NRW jaringan, dalam poin persen.
 *
 * Jaringan tua di Bandung Timur kehilangan lebih banyak daripada Sumedang yang
 * pipanya lebih baru. Tanpa selisih ini keempat zona melaporkan angka yang
 * nyaris sama, dan tabel "rincian per zona" tidak memberi tahu apa pun.
 */
const WATAK_ZONA: Record<string, number> = {
  "Bandung Timur": 2.4,
  Cileunyi: -0.6,
  Cimahi: 0.8,
  Sumedang: -2.1,
};

const JIWA_PER_SAMBUNGAN = 3.9; // acuan BPS; samakan dengan src/lib/neraca.ts
const TERCATAT_L_ORANG_HARI = 158; // pemakaian rumah tangga perkotaan yang lazim
const NRW_ACUAN = 0.21;

/**
 * Tanggal murni pukul 00.00 UTC.
 *
 * Kolomnya `@db.Date`; mengirim cap waktu sore hari membuat Postgres
 * memotongnya menurut zona waktu sesi, dan baris bisa mendarat di tanggal yang
 * salah sehari.
 */
function tanggalMurni(geserHari: number): Date {
  const d = new Date(Date.now() - geserHari * 86_400_000);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export interface BarisNeraca {
  zonaId: string;
  tanggal: Date;
  volumeIndukL: number;
  volumeTercatatL: number;
}

/**
 * Membangkitkan bacaan harian untuk seluruh zona yang dikenal.
 *
 * `idPerNama` memetakan nama zona ke id-nya di basis data. Zona yang tidak ada
 * di `PORSI_ZONA` dilewati — jaringan sungguhan boleh punya zona lain, dan
 * mengarang porsi untuknya akan membuat totalnya melebihi produksi.
 *
 * Produksi harian DITURUNKAN dari jumlah sambungan, tidak dipatok. Versi
 * pertama memakai 1180 m³/hari — angka yang masuk akal untuk sebuah kota,
 * tetapi basis data demo ini hanya berisi 120 sambungan. Akibatnya halaman
 * statistik melaporkan 2.028 liter/orang/hari, sekitar tiga belas kali
 * pemakaian rumah tangga yang wajar, dan "pemenuhan kebutuhan dasar" tertulis
 * 3.381%. Angka sebesar itu tidak perlu diaudit untuk ketahuan salah.
 */
export function barisNeraca(
  idPerNama: Map<string, string>,
  jumlahSambungan: number,
  hariTotal = HARI_NERACA,
): BarisNeraca[] {
  const r = acak(BENIH_NERACA);
  const produksiDasarM3 =
    (jumlahSambungan * JIWA_PER_SAMBUNGAN * TERCATAT_L_ORANG_HARI) /
    1000 /
    (1 - NRW_ACUAN);

  const hasil: BarisNeraca[] = [];

  for (let g = hariTotal - 1; g >= 0; g--) {
    const tanggal = tanggalMurni(g);
    // Umur dalam bulan, dihitung mundur dari hari ini. Dipakai supaya
    // perbaikan NRW berjalan menurut waktu, bukan menurut nomor baris.
    const bulanLalu = g / 30.44;

    /*
     * NRW menurun pelan dari sekitar 24% menjadi sekitar 20% dalam setahun,
     * bergoyang, dan belum melewati garis target 20%. Garis lurus menurun akan
     * terbaca sebagai karangan, dan deret yang selalu di bawah target
     * menghapus satu-satunya hal menarik dari grafik tren.
     */
    const nrwDasar = 19.4 + bulanLalu * 0.35 + Math.sin(bulanLalu * 1.1) * 0.55;

    // Akhir pekan sedikit lebih tinggi: rumah tangga lebih banyak di rumah.
    const hariPekan = tanggal.getUTCDay();
    const akhirPekan = hariPekan === 0 || hariPekan === 6 ? 1.04 : 1;
    const produksiJaringanM3 =
      produksiDasarM3 *
      (1 + Math.sin(bulanLalu / 1.9) * 0.047) *
      akhirPekan *
      (0.985 + r() * 0.03);

    for (const [nama, porsi] of Object.entries(PORSI_ZONA)) {
      const zonaId = idPerNama.get(nama);
      if (!zonaId) continue;

      const nrwZona = Math.min(
        34,
        Math.max(9, nrwDasar + (WATAK_ZONA[nama] ?? 0) + (r() - 0.5) * 1.6),
      );

      const indukL = Math.round(produksiJaringanM3 * porsi * 1000);
      hasil.push({
        zonaId,
        tanggal,
        volumeIndukL: indukL,
        // Tercatat DITURUNKAN dari induk dan NRW, bukan dibangkitkan sendiri.
        // Kalau keduanya diacak terpisah, NRW hasil bagi di API akan keluar
        // dari kisaran yang masuk akal pada hari-hari tertentu.
        volumeTercatatL: Math.round(indukL * (1 - nrwZona / 100)),
      });
    }
  }

  return hasil;
}
