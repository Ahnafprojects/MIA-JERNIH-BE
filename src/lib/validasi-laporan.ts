/**
 * Validasi ringan laporan pengaduan warga.
 *
 * ── Prinsip yang mengikat seluruh berkas ini ──────────────────────────
 *
 * Fungsi di sini MENANDAI, tidak pernah MENOLAK. Warga yang pipanya bocor
 * lalu laporannya ditolak karena fotonya kehilangan EXIF adalah kegagalan
 * yang jauh lebih mahal daripada satu laporan spam yang lolos ke meja
 * petugas. Satu-satunya hal yang boleh benar-benar menghalangi adalah
 * pembatasan laju, dan itu pun dengan ambang yang longgar.
 *
 * Karena itu tiap fungsi mengembalikan penilaian berikut ALASANNYA, supaya
 * petugas bisa menimbang sendiri. Tidak ada satu pun yang melempar galat.
 */

/** Sumber koordinat laporan, dari yang paling kuat ke paling lemah. */
export type SumberLokasi =
  /** Dibaca dari GPS perangkat warga lewat izin peramban. */
  | "GPS_PERANGKAT"
  /** Warga menggeser sendiri penanda di peta. */
  | "DIPILIH_MANUAL"
  /** Cadangan: koordinat meter terdaftar milik warga. */
  | "METER_TERDAFTAR"
  /** Tidak ada koordinat sama sekali. */
  | "TIDAK_ADA";

export type KeyakinanLokasi = "TINGGI" | "SEDANG" | "RENDAH" | "TIDAK_DIKETAHUI";

export interface Titik {
  lat: number;
  lng: number;
}

/**
 * Jarak wajar antara titik laporan dan meter terdaftar, dalam meter.
 *
 * Angkanya longgar dengan sengaja. Gangguan yang dilaporkan warga sering
 * berada di pipa induk beberapa ratus meter dari rumahnya, bukan tepat di
 * meternya sendiri. Ambang yang ketat akan menandai laporan yang justru
 * paling berguna.
 */
export const RADIUS_WAJAR_M = 2_000;

/** Selisih maksimum antara GPS foto dan titik laporan sebelum ditandai. */
export const SELISIH_FOTO_WAJAR_M = 500;

/** Rentang waktu pencarian aduan ganda. */
export const JENDELA_GANDA_JAM = 24;

/** Radius dua aduan dianggap menunjuk gangguan yang sama. */
export const RADIUS_GANDA_M = 250;

/**
 * Jarak dua titik di permukaan bumi, dalam meter (haversine).
 *
 * Dipakai untuk membandingkan jarak, bukan untuk navigasi, jadi bumi bulat
 * sempurna sudah cukup. Galatnya di bawah 0,5% dan tidak pernah mendekati
 * ambang mana pun di berkas ini.
 */
export function hitungJarakMeter(a: Titik, b: Titik): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * sinLng * sinLng;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Koordinat yang mustahil, dipakai menolak kiriman asal-asalan. */
export function koordinatMasukAkal(t: Titik): boolean {
  return (
    Number.isFinite(t.lat) &&
    Number.isFinite(t.lng) &&
    Math.abs(t.lat) <= 90 &&
    Math.abs(t.lng) <= 180 &&
    // (0,0) di Teluk Guinea. Nyaris selalu berarti variabel yang belum diisi,
    // bukan lokasi sungguhan.
    !(t.lat === 0 && t.lng === 0)
  );
}

/* ── Pembacaan GPS dari EXIF ──────────────────────────────────────────── */

/**
 * Membaca koordinat GPS dari EXIF sebuah JPEG.
 *
 * Ditulis tangan, bukan memakai pustaka, karena yang dibutuhkan hanya empat
 * tag dari satu IFD dan formatnya deterministik. Menambah dependensi untuk
 * seratus baris kode yang tidak akan pernah berubah tidak sepadan.
 *
 * ── YANG HARUS DIKETAHUI SEBELUM MEMPERCAYAI HASILNYA ─────────────────
 *
 * Nilai `null` dari fungsi ini TIDAK berarti fotonya palsu. WhatsApp,
 * Instagram, dan sebagian besar peramban MENGHAPUS seluruh EXIF saat
 * mengunggah demi privasi, dan tangkapan layar memang tidak pernah punya.
 * Dalam pemakaian nyata, mayoritas foto yang sah akan mengembalikan `null`.
 *
 * Jadi fungsi ini hanya berguna untuk MENGUATKAN laporan yang kebetulan
 * membawa EXIF, tidak pernah untuk melemahkan yang tidak membawanya.
 * Ketiadaan EXIF harus diperlakukan persis sama dengan tidak ada informasi.
 */
export function bacaGpsExif(dataUri: string): Titik | null {
  try {
    const koma = dataUri.indexOf(",");
    if (koma < 0 || !/^data:image\//i.test(dataUri)) return null;

    const buf = Buffer.from(dataUri.slice(koma + 1), "base64");
    if (buf.length < 12) return null;

    // Penanda JPEG.
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

    // Telusuri segmen sampai menemukan APP1 bertanda "Exif\0\0".
    let p = 2;
    let awalTiff = -1;
    while (p + 4 <= buf.length) {
      if (buf[p] !== 0xff) break;
      const penanda = buf[p + 1]!;
      // SOS atau EOI: data gambar dimulai, tidak ada lagi segmen metadata.
      if (penanda === 0xda || penanda === 0xd9) break;
      const panjang = buf.readUInt16BE(p + 2);
      if (panjang < 2) break;
      if (penanda === 0xe1 && p + 4 + 6 <= buf.length) {
        if (buf.toString("ascii", p + 4, p + 10) === "Exif\0\0") {
          awalTiff = p + 10;
          break;
        }
      }
      p += 2 + panjang;
    }
    if (awalTiff < 0 || awalTiff + 8 > buf.length) return null;

    // Kepala TIFF menentukan urutan byte seluruh blok sesudahnya.
    const tanda = buf.toString("ascii", awalTiff, awalTiff + 2);
    const kecilDulu = tanda === "II";
    if (!kecilDulu && tanda !== "MM") return null;

    const u16 = (o: number) =>
      kecilDulu ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const u32 = (o: number) =>
      kecilDulu ? buf.readUInt32LE(o) : buf.readUInt32BE(o);

    if (u16(awalTiff + 2) !== 0x002a) return null;

    const offsetIfd0 = u32(awalTiff + 4);
    const ifd0 = awalTiff + offsetIfd0;
    if (ifd0 + 2 > buf.length) return null;

    // Cari penunjuk ke GPS IFD (tag 0x8825) di dalam IFD0.
    const jumlah0 = u16(ifd0);
    let offsetGps = 0;
    for (let i = 0; i < jumlah0; i++) {
      const e = ifd0 + 2 + i * 12;
      if (e + 12 > buf.length) return null;
      if (u16(e) === 0x8825) {
        offsetGps = u32(e + 8);
        break;
      }
    }
    if (!offsetGps) return null;

    const gps = awalTiff + offsetGps;
    if (gps + 2 > buf.length) return null;

    /** Membaca tiga rational berturut-turut: derajat, menit, detik. */
    const bacaDms = (offsetNilai: number): number | null => {
      const dasar = awalTiff + offsetNilai;
      if (dasar + 24 > buf.length) return null;
      let hasil = 0;
      for (let i = 0; i < 3; i++) {
        const pembilang = u32(dasar + i * 8);
        const penyebut = u32(dasar + i * 8 + 4);
        if (penyebut === 0) return null;
        hasil += pembilang / penyebut / Math.pow(60, i);
      }
      return hasil;
    };

    let lat: number | null = null;
    let lng: number | null = null;
    let arahLat = "N";
    let arahLng = "E";

    const jumlahGps = u16(gps);
    for (let i = 0; i < jumlahGps; i++) {
      const e = gps + 2 + i * 12;
      if (e + 12 > buf.length) return null;
      const tag = u16(e);
      const offsetNilai = u32(e + 8);

      // Tag arah panjangnya 2 byte, jadi nilainya tersimpan INLINE di
      // kolom offset, bukan ditunjuk olehnya.
      if (tag === 0x0001) arahLat = String.fromCharCode(buf[e + 8]!);
      else if (tag === 0x0003) arahLng = String.fromCharCode(buf[e + 8]!);
      else if (tag === 0x0002) lat = bacaDms(offsetNilai);
      else if (tag === 0x0004) lng = bacaDms(offsetNilai);
    }

    if (lat === null || lng === null) return null;
    if (arahLat === "S") lat = -lat;
    if (arahLng === "W") lng = -lng;

    const titik = { lat, lng };
    return koordinatMasukAkal(titik) ? titik : null;
  } catch {
    // Foto rusak atau EXIF tidak lazim bukan alasan menggagalkan laporan.
    return null;
  }
}

/* ── Penilaian keyakinan lokasi ───────────────────────────────────────── */

export interface HasilKeyakinan {
  keyakinan: KeyakinanLokasi;
  sumber: SumberLokasi;
  /** Alasan yang bisa dibaca petugas. */
  catatan: string[];
  /** Jarak ke meter terdaftar, bila keduanya diketahui. */
  jarakKeMeterM: number | null;
  /** Jarak titik laporan ke GPS foto, bila ada. */
  jarakKeFotoM: number | null;
}

/**
 * Menilai seberapa bisa dipercaya koordinat sebuah laporan.
 *
 * Tingkatnya menggambarkan KEKUATAN BUKTI, bukan kejujuran pelapor. Laporan
 * berkeyakinan rendah tetap laporan yang sah; ia hanya butuh petugas melihat
 * sendiri sebelum menurunkan regu.
 */
export function nilaiKeyakinanLokasi(masuk: {
  titik: Titik | null;
  sumber: SumberLokasi;
  titikMeter: Titik | null;
  gpsFoto: Titik[];
}): HasilKeyakinan {
  const catatan: string[] = [];
  const { titik, sumber, titikMeter, gpsFoto } = masuk;

  if (!titik || !koordinatMasukAkal(titik)) {
    return {
      keyakinan: "TIDAK_DIKETAHUI",
      sumber: "TIDAK_ADA",
      catatan: ["Laporan tidak menyertakan koordinat."],
      jarakKeMeterM: null,
      jarakKeFotoM: null,
    };
  }

  const jarakKeMeterM = titikMeter ? hitungJarakMeter(titik, titikMeter) : null;

  // Foto terdekat yang membawa GPS dipakai sebagai penguat.
  let jarakKeFotoM: number | null = null;
  for (const g of gpsFoto) {
    const j = hitungJarakMeter(titik, g);
    if (jarakKeFotoM === null || j < jarakKeFotoM) jarakKeFotoM = j;
  }

  let keyakinan: KeyakinanLokasi =
    sumber === "GPS_PERANGKAT"
      ? "TINGGI"
      : sumber === "DIPILIH_MANUAL"
        ? "SEDANG"
        : "RENDAH";

  if (sumber === "GPS_PERANGKAT") catatan.push("Koordinat dibaca dari GPS perangkat pelapor.");
  if (sumber === "DIPILIH_MANUAL") catatan.push("Titik ditentukan sendiri oleh pelapor di peta.");
  if (sumber === "METER_TERDAFTAR")
    catatan.push("Koordinat memakai posisi meter terdaftar, bukan lokasi gangguan yang sebenarnya.");

  if (jarakKeFotoM !== null) {
    if (jarakKeFotoM <= SELISIH_FOTO_WAJAR_M) {
      catatan.push(`GPS pada foto cocok dengan titik laporan (selisih ${jarakKeFotoM} m).`);
      // Bukti independen: foto diambil di tempat yang dilaporkan.
      if (keyakinan === "SEDANG") keyakinan = "TINGGI";
      if (keyakinan === "RENDAH") keyakinan = "SEDANG";
    } else {
      catatan.push(
        `GPS pada foto berjarak ${jarakKeFotoM} m dari titik laporan. Perlu diperiksa petugas.`,
      );
      keyakinan = "RENDAH";
    }
  } else if (gpsFoto.length === 0) {
    // Disebut eksplisit supaya petugas tidak menyimpulkan fotonya mencurigakan.
    catatan.push(
      "Foto tidak membawa data GPS. Ini lazim: aplikasi pesan dan peramban menghapusnya demi privasi.",
    );
  }

  if (jarakKeMeterM !== null) {
    if (jarakKeMeterM > RADIUS_WAJAR_M) {
      catatan.push(
        `Titik laporan berjarak ${jarakKeMeterM} m dari meter terdaftar, di luar radius wajar ${RADIUS_WAJAR_M} m.`,
      );
      if (keyakinan === "TINGGI") keyakinan = "SEDANG";
      else keyakinan = "RENDAH";
    } else {
      catatan.push(`Titik laporan ${jarakKeMeterM} m dari meter terdaftar.`);
    }
  }

  return { keyakinan, sumber, catatan, jarakKeMeterM, jarakKeFotoM };
}

/* ── Deteksi aduan ganda ──────────────────────────────────────────────── */

export interface TiketRingkas {
  id: string;
  nomor: string;
  kategori: string;
  lat: number | null;
  lng: number | null;
  dibuatPada: Date;
  pelaporId: string;
}

export interface HasilGanda {
  adaDugaan: boolean;
  nomorSerupa: string[];
  alasan: string | null;
}

/**
 * Mencari aduan lain yang kemungkinan menunjuk gangguan yang sama.
 *
 * Yang dicari BUKAN pelapor nakal. Saat pipa induk pecah, puluhan warga
 * melapor hal yang sama dalam satu jam, dan itu justru informasi berharga:
 * banyaknya laporan menunjukkan luasnya dampak. Fungsi ini menandai supaya
 * petugas bisa MENGGABUNGKAN, bukan supaya sistem menolak.
 *
 * Pengecualiannya satu: aduan ganda dari pelapor yang SAMA untuk kategori
 * dan lokasi yang sama dalam rentang pendek lebih mungkin kiriman ganda
 * karena tombol terpencet dua kali.
 */
export function cariDugaanGanda(
  baru: { kategori: string; titik: Titik | null; pelaporId: string },
  kandidat: TiketRingkas[],
): HasilGanda {
  const serupa = kandidat.filter((t) => {
    if (t.kategori.toLowerCase() !== baru.kategori.toLowerCase()) return false;
    if (!baru.titik || t.lat === null || t.lng === null) return false;
    return (
      hitungJarakMeter(baru.titik, { lat: t.lat, lng: t.lng }) <= RADIUS_GANDA_M
    );
  });

  if (serupa.length === 0) {
    return { adaDugaan: false, nomorSerupa: [], alasan: null };
  }

  const dariPelaporSama = serupa.filter((t) => t.pelaporId === baru.pelaporId);
  const nomorSerupa = serupa.map((t) => t.nomor);

  if (dariPelaporSama.length > 0) {
    return {
      adaDugaan: true,
      nomorSerupa,
      alasan: `Anda sudah melaporkan kategori yang sama di lokasi ini dalam ${JENDELA_GANDA_JAM} jam terakhir (${dariPelaporSama
        .map((t) => t.nomor)
        .join(", ")}). Laporan ini tetap dicatat.`,
    };
  }

  return {
    adaDugaan: true,
    nomorSerupa,
    alasan: `Ada ${serupa.length} laporan lain untuk gangguan serupa di sekitar lokasi ini. Petugas akan menanganinya bersamaan.`,
  };
}
