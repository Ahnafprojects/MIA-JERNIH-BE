/**
 * Peringkasan titik kebocoran pipa untuk peta PUBLIK.
 *
 * ── Kenapa berkas ini ada, dan kenapa hati-hati ───────────────────────
 *
 * Kepala `src/rute/publik.ts` berjanji: "Tidak ada data pribadi (PII): nama,
 * email, hp, alamat, ID meter, KOORDINAT RUMAH." Janji itu bukan basa-basi —
 * endpoint `/api/publik/peta` pernah memancarkan satu titik per insiden pada
 * koordinat meternya, lalu SENGAJA dicabut karena itu cukup untuk menunjukkan
 * rumah mana yang sedang bermasalah.
 *
 * Peta sebaran kebocoran diminta justru menitikkan lokasi. Supaya keduanya
 * tidak bertabrakan, berkas ini memberlakukan tiga pembatas sekaligus, dan
 * ketiganya harus tetap ada:
 *
 * 1. HANYA kategori "kebocoran pipa". Kategori lain — air tidak mengalir,
 *    tekanan lemah, air keruh, meter rusak — adalah gangguan DI RUMAH
 *    seseorang. Menitikkannya di peta publik sama dengan mengumumkan rumah
 *    siapa yang bermasalah. Kebocoran pipa adalah cacat infrastruktur: ia
 *    ada di gang, di tepi jalan, di bawah trotoar.
 *
 * 2. Koordinatnya DIBULATKAN ke petak ~110 m, lalu yang dilaporkan titik
 *    TENGAH petak, bukan titik aslinya. Pin yang digeser warga bisa saja
 *    berhenti tepat di pagar rumahnya sendiri — halaman pengaduan punya
 *    tombol "Gunakan lokasi saya", jadi sebagian titik memang akan jatuh di
 *    rumah pelapor. Membulatkan ke petak membuat yang terbaca "ada kebocoran
 *    di sekitar sini", bukan "di rumah ini".
 *
 * 3. Aduan dalam satu petak DIGABUNG jadi satu titik berisi hitungan. Ini
 *    juga yang membuat peta tetap terbaca saat satu ruas pipa diadukan
 *    belasan orang sekaligus.
 *
 * Yang TIDAK PERNAH keluar dari sini: `nomor` tiket. Itu bukan sekadar
 * label — `GET /api/publik/lacak/:nomor` membuka detail tiket kepada siapa
 * pun yang memegang nomornya. Menyiarkan nomor di peta sama dengan
 * membagikan kredensial pelacakan untuk setiap aduan yang masuk. Begitu juga
 * `pelaporId`, `meterId`, `deskripsi`, dan `fotoUrl`: deskripsi ditulis bebas
 * oleh warga dan sering memuat nama gang, nomor rumah, atau nama tetangga.
 */

/**
 * Sisi petak dalam derajat. 0,001° ≈ 110 m di lintang Indonesia.
 *
 * Dinaikkan nilainya = petak makin besar = makin kabur. Kalau suatu saat
 * ternyata masih terlalu rinci, UBAH ANGKA INI, jangan menambal di pemanggil.
 */
export const SISI_PETAK_DERAJAT = 0.001;

/** Hanya kategori ini yang boleh tergambar di peta publik. Lihat pembatas 1. */
export const KATEGORI_PUBLIK = "kebocoran pipa";

/** Berapa hari ke belakang yang dianggap "riwayat". */
export const RENTANG_HARI_BAWAAN = 90;
export const RENTANG_HARI_MAKS = 365;

export type StatusTiketNilai = "BARU" | "DIPROSES" | "SELESAI";

export interface TiketMentah {
  lat: number | null;
  lng: number | null;
  status: StatusTiketNilai;
  slaJatuhTempo: Date;
  selesaiPada: Date | null;
  dibuatPada: Date;
}

export interface PetakKebocoran {
  /** Titik TENGAH petak, bukan koordinat aduan mana pun. */
  lat: number;
  lng: number;
  /** Total aduan kebocoran di petak ini dalam rentang yang diminta. */
  jumlah: number;
  /** Masih ditangani (BARU atau DIPROSES). */
  berjalan: number;
  /** Sudah ditutup. */
  selesai: number;
  /**
   * Masih berjalan DAN sudah melewati tenggat SLA-nya.
   *
   * Ini angka yang paling berguna bagi warga sekaligus paling tidak nyaman
   * bagi penyelenggara, dan justru karena itu ia diterbitkan.
   */
  terlambat: number;
  /**
   * Rata-rata jam penyelesaian untuk yang sudah selesai di petak ini, atau
   * `null` bila belum ada satu pun yang selesai. BUKAN 0 — nol berarti
   * "selesai seketika", dan itu klaim yang berbeda.
   */
  rataJamPerbaikan: number | null;
  /**
   * Tanggal aduan terbaru di petak ini, TANPA jam.
   *
   * Jamnya dipotong dengan sengaja: stempel waktu presisi detik bisa
   * dicocokkan dengan satu aduan tertentu, dan itu membatalkan gunanya
   * membulatkan koordinat.
   */
  terbaruPada: string;
}

/** Membulatkan satu sumbu ke titik tengah petaknya. */
function keTengahPetak(nilai: number): number {
  const indeks = Math.floor(nilai / SISI_PETAK_DERAJAT);
  const tengah = (indeks + 0.5) * SISI_PETAK_DERAJAT;
  // Dibulatkan ke 6 desimal supaya tidak membawa ekor galat floating point
  // yang justru membuat angkanya terlihat lebih presisi daripada maksudnya.
  return Number(tengah.toFixed(6));
}

/** Kunci petak untuk pengelompokan. */
function kunciPetak(lat: number, lng: number): string {
  return `${Math.floor(lat / SISI_PETAK_DERAJAT)}:${Math.floor(lng / SISI_PETAK_DERAJAT)}`;
}

/**
 * Meringkas daftar tiket mentah menjadi petak-petak siap kirim.
 *
 * Tiket tanpa koordinat DIBUANG, bukan ditaruh di titik bawaan. Menaruhnya
 * di pusat kota akan memunculkan gundukan palsu di sana — peta yang
 * berbohong lebih buruk daripada peta yang mengaku datanya kurang.
 */
export function ringkasTitikKebocoran(
  tiketList: TiketMentah[],
  sekarang: Date,
): PetakKebocoran[] {
  interface Ember {
    lat: number;
    lng: number;
    jumlah: number;
    berjalan: number;
    selesai: number;
    terlambat: number;
    totalJam: number;
    jumlahSelesaiBerjam: number;
    terbaru: Date;
  }

  const peta = new Map<string, Ember>();

  for (const t of tiketList) {
    if (t.lat === null || t.lng === null) continue;
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) continue;

    const kunci = kunciPetak(t.lat, t.lng);
    let ember = peta.get(kunci);
    if (!ember) {
      ember = {
        lat: keTengahPetak(t.lat),
        lng: keTengahPetak(t.lng),
        jumlah: 0,
        berjalan: 0,
        selesai: 0,
        terlambat: 0,
        totalJam: 0,
        jumlahSelesaiBerjam: 0,
        terbaru: t.dibuatPada,
      };
      peta.set(kunci, ember);
    }

    ember.jumlah += 1;
    if (t.dibuatPada > ember.terbaru) ember.terbaru = t.dibuatPada;

    if (t.status === "SELESAI") {
      ember.selesai += 1;
      if (t.selesaiPada) {
        const jam = (t.selesaiPada.getTime() - t.dibuatPada.getTime()) / 3_600_000;
        // Durasi negatif berarti datanya kacau (selesai sebelum dibuat).
        // Dibuang, bukan dipaksa nol: nol akan menarik rata-rata ke bawah dan
        // membuat kinerjanya terlihat lebih baik daripada kenyataannya.
        if (jam >= 0) {
          ember.totalJam += jam;
          ember.jumlahSelesaiBerjam += 1;
        }
      }
    } else {
      ember.berjalan += 1;
      if (t.slaJatuhTempo < sekarang) ember.terlambat += 1;
    }
  }

  return [...peta.values()]
    .map((e) => ({
      lat: e.lat,
      lng: e.lng,
      jumlah: e.jumlah,
      berjalan: e.berjalan,
      selesai: e.selesai,
      terlambat: e.terlambat,
      rataJamPerbaikan:
        e.jumlahSelesaiBerjam > 0
          ? Number((e.totalJam / e.jumlahSelesaiBerjam).toFixed(1))
          : null,
      terbaruPada: e.terbaru.toISOString().slice(0, 10),
    }))
    // Urutan tetap supaya jawaban yang sama menghasilkan bytes yang sama;
    // tanpa ini cache di depan endpoint ini akan meleset terus.
    .sort((a, b) => (a.lat === b.lat ? a.lng - b.lng : a.lat - b.lat));
}

/** Membaca parameter `hari` dengan batas atas yang jelas. */
export function bacaRentangHari(mentah: unknown): number {
  const n = Number(mentah);
  if (!Number.isFinite(n) || n <= 0) return RENTANG_HARI_BAWAAN;
  return Math.min(Math.floor(n), RENTANG_HARI_MAKS);
}
