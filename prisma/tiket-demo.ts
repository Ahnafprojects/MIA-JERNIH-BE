/**
 * Pembangkit tiket pengaduan untuk basis data peragaan.
 *
 * Dipakai dua pemanggil yang tidak boleh berselisih:
 *
 * - `prisma/seed.ts`     menyusun ulang basis data dari nol.
 * - `prisma/isi-tiket.ts` menambah tiket di server tanpa menghapus apa pun.
 *
 * Sama alasannya dengan `neraca-demo.ts`: kalau keduanya memakai rumus
 * sendiri, basis data lokal dan produksi akan memperlihatkan rapor kinerja
 * yang berbeda untuk sistem yang sama.
 */

/** Kategori pengaduan beserta tenggat SLA dalam jam. */
export const KATEGORI_TIKET = [
  ["kebocoran pipa", 6],
  ["air tidak mengalir", 12],
  ["air keruh/berbau", 24],
  ["tekanan lemah", 24],
  ["meter/keypad rusak", 48],
  ["lainnya", 72],
] as const;

/** Jumlah tiket yang dianggap cukup untuk mengisi seluruh rentang halaman. */
export const TARGET_TIKET = 320;

/**
 * Sebaran 100 hari, bukan 25.
 *
 * Halaman Rapor Kinerja melayani rentang 7, 30, dan 90 hari. Dengan sebaran
 * 25 hari, rentang 90 hari berisi 65 hari kosong dan grafiknya putus-putus.
 */
export const HARI_SEBAR_TIKET = 100;

const JAM = 3_600_000;

export type StatusTiketDemo = "BARU" | "DIPROSES" | "SELESAI";

export interface BarisTiket {
  nomor: string;
  pelaporId: string;
  meterId: string;
  kategori: string;
  deskripsi: string;
  fotoUrl: string[];
  status: StatusTiketDemo;
  teknisiId: string | null;
  slaJatuhTempo: Date;
  ditanggapiPada: Date | null;
  selesaiPada: Date | null;
  dibuatPada: Date;
}

export interface MeterPelapor {
  id: string;
  penggunaId: string;
}

export interface OpsiTiket {
  /** Meter bertuan yang boleh dipakai sebagai pelapor. */
  meter: MeterPelapor[];
  /** Teknisi yang ditugaskan pada tiket yang sudah ditangani. */
  teknisiId: string;
  /** Berapa tiket yang dibuat. */
  jumlah: number;
  /** Nomor urut terpakai per bulan, agar penomoran tidak bertabrakan. */
  urutTerpakai?: Map<string, number>;
  /** Pengacak; diberikan pemanggil supaya hasilnya bisa diulang. */
  acak: () => number;
}

/**
 * Membangkitkan tiket dengan ketepatan SLA yang MEMBAIK seiring waktu.
 *
 * Ketepatan acak menghasilkan garis bergerigi tanpa arah, dan grafik yang
 * tidak punya arah tidak menjawab pertanyaan yang dibawa pembaca ke halaman
 * Rapor Kinerja: apakah layanannya membaik atau memburuk. Di sini peluang
 * telat menyusut dari sekitar 22% pada 100 hari lalu menjadi sekitar 7%
 * sekarang.
 */
export function barisTiket(opsi: OpsiTiket): BarisTiket[] {
  const { meter, teknisiId, jumlah, acak: r } = opsi;
  if (meter.length === 0) return [];

  const urutBulan = opsi.urutTerpakai ?? new Map<string, number>();
  const kini = Date.now();
  const hasil: BarisTiket[] = [];

  const pilih = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

  for (let i = 0; i < jumlah; i++) {
    const [kategori, slaJam] = pilih(KATEGORI_TIKET);
    const m = pilih(meter);

    const umurHari = r() * HARI_SEBAR_TIKET;
    const dibuat = new Date(kini - umurHari * 24 * JAM);
    const jatuhTempo = new Date(dibuat.getTime() + slaJam * JAM);

    const peluangTelat = 0.07 + (umurHari / HARI_SEBAR_TIKET) * 0.15;
    const selesai = r() > 0.1;
    const telat = r() < peluangTelat;
    const durasiJam = telat
      ? slaJam * (1.1 + r() * 0.8)
      : slaJam * (0.25 + r() * 0.6);
    const selesaiPada = selesai
      ? new Date(dibuat.getTime() + durasiJam * JAM)
      : null;

    const status: StatusTiketDemo = selesai
      ? "SELESAI"
      : pilih(["BARU", "DIPROSES"] as const);

    /*
     * Waktu tanggap hanya untuk tiket yang sudah keluar dari BARU. Tiket yang
     * masih BARU belum ditanggapi siapa pun, jadi kolomnya null; itu yang
     * menjaga rata-rata waktu tanggap di halaman publik tidak tercemar tiket
     * yang belum disentuh.
     */
    const ditanggapiPada =
      status === "BARU"
        ? null
        : new Date(dibuat.getTime() + (15 + Math.floor(r() * 165)) * 60_000);

    /*
     * Nomor diturunkan dari TANGGAL tiketnya. Memakai satu bulan tetap
     * membuat tiket bertanggal September bernomor Oktober, dan orang pertama
     * yang mencocokkan nomor dengan tanggal di halaman lacak menemukannya.
     */
    const kunciBulan = `${dibuat.getFullYear()}-${String(dibuat.getMonth() + 1).padStart(2, "0")}`;
    const urut = (urutBulan.get(kunciBulan) ?? 0) + 1;
    urutBulan.set(kunciBulan, urut);

    hasil.push({
      nomor: `LP-${kunciBulan}-${String(urut).padStart(4, "0")}`,
      pelaporId: m.penggunaId,
      meterId: m.id,
      kategori,
      deskripsi: `Laporan warga perihal ${kategori.toLowerCase()} pada saluran air.`,
      fotoUrl: [],
      status,
      teknisiId: selesai || r() > 0.5 ? teknisiId : null,
      slaJatuhTempo: jatuhTempo,
      ditanggapiPada,
      selesaiPada,
      dibuatPada: dibuat,
    });
  }

  return hasil;
}
