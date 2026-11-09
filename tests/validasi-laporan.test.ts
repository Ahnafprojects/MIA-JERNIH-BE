/**
 * Validasi laporan pengaduan: jarak, pembacaan GPS dari EXIF, penilaian
 * keyakinan lokasi, dan deteksi aduan ganda.
 *
 * Pembaca EXIF-nya ditulis tangan dan mengurai byte mentah, jadi yang diuji
 * di sini bukan kerapian kode melainkan apakah ia benar-benar mengembalikan
 * koordinat yang benar dari berkas sungguhan — dan, yang sama pentingnya,
 * apakah ia mengembalikan `null` dengan tenang untuk masukan rusak alih-alih
 * melempar galat yang menggagalkan seluruh laporan.
 */
import { describe, expect, it } from "vitest";
import {
  RADIUS_GANDA_M,
  RADIUS_WAJAR_M,
  bacaGpsExif,
  cariDugaanGanda,
  hitungJarakMeter,
  koordinatMasukAkal,
  nilaiKeyakinanLokasi,
  type TiketRingkas,
} from "../src/lib/validasi-laporan.js";

/* ── Pembangun JPEG ber-EXIF untuk pengujian ──────────────────────────── */

/**
 * Menyusun JPEG minimal yang membawa GPS IFD sungguhan.
 *
 * Dibuat di sini, bukan disimpan sebagai berkas biner, supaya koordinat yang
 * diharapkan terbaca langsung dari kode ujinya. Berkas biner di repo tidak
 * bisa diperiksa mata saat ujinya suatu hari gagal.
 */
function jpegDenganGps(
  lat: [number, number, number],
  lng: [number, number, number],
  arahLat: "N" | "S",
  arahLng: "E" | "W",
  kecilDulu = false,
): string {
  const rational = (nilai: [number, number, number]): Buffer => {
    const b = Buffer.alloc(24);
    nilai.forEach((v, i) => {
      // Dikalikan 100 lalu dibagi 100 supaya pecahan menit/detik ikut teruji,
      // bukan hanya bilangan bulat.
      const pembilang = Math.round(v * 100);
      if (kecilDulu) {
        b.writeUInt32LE(pembilang, i * 8);
        b.writeUInt32LE(100, i * 8 + 4);
      } else {
        b.writeUInt32BE(pembilang, i * 8);
        b.writeUInt32BE(100, i * 8 + 4);
      }
    });
    return b;
  };

  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    if (kecilDulu) b.writeUInt16LE(v, 0);
    else b.writeUInt16BE(v, 0);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    if (kecilDulu) b.writeUInt32LE(v, 0);
    else b.writeUInt32BE(v, 0);
    return b;
  };

  // Tata letak relatif terhadap awal kepala TIFF.
  const OFFSET_IFD0 = 8;
  const jumlahIfd0 = 1;
  const panjangIfd0 = 2 + jumlahIfd0 * 12 + 4;
  const OFFSET_GPS_IFD = OFFSET_IFD0 + panjangIfd0;
  const jumlahGps = 4;
  const panjangGpsIfd = 2 + jumlahGps * 12 + 4;
  const OFFSET_NILAI_LAT = OFFSET_GPS_IFD + panjangGpsIfd;
  const OFFSET_NILAI_LNG = OFFSET_NILAI_LAT + 24;

  const kepalaTiff = Buffer.concat([
    Buffer.from(kecilDulu ? "II" : "MM", "ascii"),
    u16(0x002a),
    u32(OFFSET_IFD0),
  ]);

  // IFD0 hanya memuat satu entri: penunjuk ke GPS IFD.
  const ifd0 = Buffer.concat([
    u16(jumlahIfd0),
    u16(0x8825), // GPSInfoIFDPointer
    u16(4), // LONG
    u32(1),
    u32(OFFSET_GPS_IFD),
    u32(0), // tidak ada IFD berikutnya
  ]);

  /** Tag arah: tipe ASCII, 2 byte, tersimpan INLINE di kolom offset. */
  const entriArah = (tag: number, huruf: string) =>
    Buffer.concat([
      u16(tag),
      u16(2), // ASCII
      u32(2),
      Buffer.from(huruf + "\0", "ascii"),
      Buffer.alloc(2),
    ]);

  const entriKoordinat = (tag: number, offsetNilai: number) =>
    Buffer.concat([
      u16(tag),
      u16(5), // RATIONAL
      u32(3),
      u32(offsetNilai),
    ]);

  const gpsIfd = Buffer.concat([
    u16(jumlahGps),
    entriArah(0x0001, arahLat),
    entriKoordinat(0x0002, OFFSET_NILAI_LAT),
    entriArah(0x0003, arahLng),
    entriKoordinat(0x0004, OFFSET_NILAI_LNG),
    u32(0),
  ]);

  const blokTiff = Buffer.concat([
    kepalaTiff,
    ifd0,
    gpsIfd,
    rational(lat),
    rational(lng),
  ]);

  const isiApp1 = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), blokTiff]);
  const panjangApp1 = Buffer.alloc(2);
  panjangApp1.writeUInt16BE(isiApp1.length + 2, 0);

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe1]), // APP1
    panjangApp1,
    isiApp1,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);

  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/* ── Jarak ────────────────────────────────────────────────────────────── */

describe("hitungJarakMeter", () => {
  it("mengembalikan nol untuk titik yang sama", () => {
    expect(hitungJarakMeter({ lat: -6.9, lng: 107.6 }, { lat: -6.9, lng: 107.6 })).toBe(0);
  });

  it("menghitung jarak pendek dengan galat di bawah 2 persen", () => {
    // 0,01 derajat lintang ~ 1.111 m di mana pun.
    const j = hitungJarakMeter({ lat: -6.9, lng: 107.6 }, { lat: -6.91, lng: 107.6 });
    expect(j).toBeGreaterThan(1_090);
    expect(j).toBeLessThan(1_130);
  });

  it("simetris", () => {
    const a = { lat: -6.93144, lng: 107.66708 };
    const b = { lat: -6.9175, lng: 107.6191 };
    expect(hitungJarakMeter(a, b)).toBe(hitungJarakMeter(b, a));
  });
});

describe("koordinatMasukAkal", () => {
  it("menolak nol-nol, yang nyaris selalu variabel belum diisi", () => {
    expect(koordinatMasukAkal({ lat: 0, lng: 0 })).toBe(false);
  });

  it("menolak lintang di luar rentang", () => {
    expect(koordinatMasukAkal({ lat: 91, lng: 107 })).toBe(false);
    expect(koordinatMasukAkal({ lat: -6.9, lng: 181 })).toBe(false);
  });

  it("menolak NaN", () => {
    expect(koordinatMasukAkal({ lat: Number.NaN, lng: 107 })).toBe(false);
  });

  it("menerima koordinat Bandung", () => {
    expect(koordinatMasukAkal({ lat: -6.93144, lng: 107.66708 })).toBe(true);
  });
});

/* ── EXIF ─────────────────────────────────────────────────────────────── */

describe("bacaGpsExif", () => {
  it("membaca koordinat dari EXIF big-endian (MM)", () => {
    // 6° 55' 51" S, 107° 36' 68.76" E
    const uri = jpegDenganGps([6, 55, 51], [107, 36, 68.76], "S", "E");
    const g = bacaGpsExif(uri);
    expect(g).not.toBeNull();
    expect(g!.lat).toBeCloseTo(-(6 + 55 / 60 + 51 / 3600), 5);
    expect(g!.lng).toBeCloseTo(107 + 36 / 60 + 68.76 / 3600, 5);
  });

  it("membaca koordinat dari EXIF little-endian (II)", () => {
    const uri = jpegDenganGps([6, 55, 51], [107, 36, 68.76], "S", "E", true);
    const g = bacaGpsExif(uri);
    expect(g).not.toBeNull();
    expect(g!.lat).toBeCloseTo(-(6 + 55 / 60 + 51 / 3600), 5);
  });

  it("menghormati arah S dan W sebagai nilai negatif", () => {
    const utara = bacaGpsExif(jpegDenganGps([6, 0, 0], [107, 0, 0], "N", "E"));
    const selatan = bacaGpsExif(jpegDenganGps([6, 0, 0], [107, 0, 0], "S", "W"));
    expect(utara!.lat).toBeCloseTo(6, 6);
    expect(utara!.lng).toBeCloseTo(107, 6);
    expect(selatan!.lat).toBeCloseTo(-6, 6);
    expect(selatan!.lng).toBeCloseTo(-107, 6);
  });

  /*
   * Kelompok berikut yang paling penting. Fungsi ini dipanggil pada tiap foto
   * yang diunggah warga, jadi satu lemparan galat di sini akan menggagalkan
   * laporan yang sah. Semuanya harus mengembalikan `null` dengan tenang.
   */
  it("mengembalikan null, bukan melempar, untuk masukan rusak", () => {
    expect(bacaGpsExif("")).toBeNull();
    expect(bacaGpsExif("bukan data uri")).toBeNull();
    expect(bacaGpsExif("data:image/jpeg;base64,")).toBeNull();
    expect(bacaGpsExif("data:image/jpeg;base64,!!!bukan-base64!!!")).toBeNull();
    expect(bacaGpsExif("data:text/plain;base64,aGFsbw==")).toBeNull();
  });

  it("mengembalikan null untuk JPEG tanpa EXIF", () => {
    const polos = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(bacaGpsExif(`data:image/jpeg;base64,${polos.toString("base64")}`)).toBeNull();
  });

  it("mengembalikan null untuk PNG, yang tidak punya APP1", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(bacaGpsExif(`data:image/png;base64,${png.toString("base64")}`)).toBeNull();
  });

  it("mengembalikan null saat blok EXIF terpotong di tengah", () => {
    const utuh = jpegDenganGps([6, 55, 51], [107, 36, 0], "S", "E");
    const base64 = utuh.slice(utuh.indexOf(",") + 1);
    const buf = Buffer.from(base64, "base64");
    // Potong setelah kepala TIFF supaya GPS IFD-nya hilang separuh.
    const potong = buf.subarray(0, 24);
    expect(bacaGpsExif(`data:image/jpeg;base64,${potong.toString("base64")}`)).toBeNull();
  });
});

/* ── Keyakinan lokasi ─────────────────────────────────────────────────── */

const METER = { lat: -6.93144, lng: 107.66708 };

describe("nilaiKeyakinanLokasi", () => {
  it("TIDAK_DIKETAHUI bila tidak ada koordinat sama sekali", () => {
    const h = nilaiKeyakinanLokasi({
      titik: null,
      sumber: "TIDAK_ADA",
      titikMeter: METER,
      gpsFoto: [],
    });
    expect(h.keyakinan).toBe("TIDAK_DIKETAHUI");
    expect(h.sumber).toBe("TIDAK_ADA");
  });

  it("TINGGI untuk GPS perangkat di dekat meter", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "GPS_PERANGKAT",
      titikMeter: METER,
      gpsFoto: [],
    });
    expect(h.keyakinan).toBe("TINGGI");
    expect(h.jarakKeMeterM).toBeLessThan(100);
  });

  it("SEDANG untuk titik yang dipilih manual", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "DIPILIH_MANUAL",
      titikMeter: METER,
      gpsFoto: [],
    });
    expect(h.keyakinan).toBe("SEDANG");
  });

  it("RENDAH saat memakai koordinat meter sebagai cadangan", () => {
    const h = nilaiKeyakinanLokasi({
      titik: METER,
      sumber: "METER_TERDAFTAR",
      titikMeter: METER,
      gpsFoto: [],
    });
    expect(h.keyakinan).toBe("RENDAH");
    expect(h.catatan.join(" ")).toContain("bukan lokasi gangguan yang sebenarnya");
  });

  it("GPS foto yang cocok MENGUATKAN pilihan manual menjadi TINGGI", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "DIPILIH_MANUAL",
      titikMeter: METER,
      gpsFoto: [{ lat: -6.9316, lng: 107.6672 }],
    });
    expect(h.keyakinan).toBe("TINGGI");
    expect(h.jarakKeFotoM).toBeLessThan(100);
  });

  it("GPS foto yang jauh menurunkan keyakinan ke RENDAH", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "GPS_PERANGKAT",
      titikMeter: METER,
      // Jakarta, ratusan kilometer dari titik laporan.
      gpsFoto: [{ lat: -6.2088, lng: 106.8456 }],
    });
    expect(h.keyakinan).toBe("RENDAH");
    expect(h.catatan.join(" ")).toContain("Perlu diperiksa petugas");
  });

  it("menyebut ketiadaan EXIF sebagai hal lazim, bukan kecurigaan", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "DIPILIH_MANUAL",
      titikMeter: METER,
      gpsFoto: [],
    });
    const teks = h.catatan.join(" ");
    expect(teks).toContain("lazim");
    // Yang penting: ketiadaan EXIF tidak menurunkan keyakinan.
    expect(h.keyakinan).toBe("SEDANG");
  });

  it("menandai titik jauh di luar radius wajar dari meter", () => {
    const h = nilaiKeyakinanLokasi({
      // Jakarta, jauh di luar RADIUS_WAJAR_M dari meter Bandung.
      titik: { lat: -6.2088, lng: 106.8456 },
      sumber: "GPS_PERANGKAT",
      titikMeter: METER,
      gpsFoto: [],
    });
    expect(h.jarakKeMeterM).toBeGreaterThan(RADIUS_WAJAR_M);
    expect(h.keyakinan).toBe("SEDANG");
    expect(h.catatan.join(" ")).toContain("di luar radius wajar");
  });

  it("tidak pernah melempar saat meter belum berkoordinat", () => {
    const h = nilaiKeyakinanLokasi({
      titik: { lat: -6.9315, lng: 107.6671 },
      sumber: "DIPILIH_MANUAL",
      titikMeter: null,
      gpsFoto: [],
    });
    expect(h.jarakKeMeterM).toBeNull();
    expect(h.keyakinan).toBe("SEDANG");
  });
});

/* ── Aduan ganda ──────────────────────────────────────────────────────── */

function tiket(p: Partial<TiketRingkas> & { nomor: string }): TiketRingkas {
  return {
    id: p.id ?? p.nomor,
    nomor: p.nomor,
    kategori: p.kategori ?? "kebocoran pipa",
    // `in` dipakai, BUKAN `??`: uji "tiket tanpa koordinat" mengirim `null`
    // dengan sengaja, dan `??` akan menggantinya dengan nilai bawaan sehingga
    // ujinya diam-diam menguji hal yang berbeda dari yang tertulis.
    lat: "lat" in p ? (p.lat as number | null) : -6.9315,
    lng: "lng" in p ? (p.lng as number | null) : 107.6671,
    dibuatPada: p.dibuatPada ?? new Date(),
    pelaporId: p.pelaporId ?? "warga-lain",
  };
}

describe("cariDugaanGanda", () => {
  const baru = {
    kategori: "kebocoran pipa",
    titik: { lat: -6.9315, lng: 107.6671 },
    pelaporId: "warga-a",
  };

  it("tidak menandai apa pun saat tidak ada kandidat", () => {
    expect(cariDugaanGanda(baru, []).adaDugaan).toBe(false);
  });

  it("mengabaikan kategori yang berbeda", () => {
    const h = cariDugaanGanda(baru, [tiket({ nomor: "LP-1", kategori: "tekanan lemah" })]);
    expect(h.adaDugaan).toBe(false);
  });

  it("mengabaikan tiket tanpa koordinat", () => {
    const h = cariDugaanGanda(baru, [tiket({ nomor: "LP-1", lat: null, lng: null })]);
    expect(h.adaDugaan).toBe(false);
  });

  it("mengabaikan lokasi di luar radius ganda", () => {
    const h = cariDugaanGanda(baru, [
      tiket({ nomor: "LP-1", lat: -6.2088, lng: 106.8456 }),
    ]);
    expect(h.adaDugaan).toBe(false);
  });

  it("menandai laporan warga LAIN sebagai gangguan yang sama, bukan spam", () => {
    const h = cariDugaanGanda(baru, [tiket({ nomor: "LP-1", pelaporId: "warga-b" })]);
    expect(h.adaDugaan).toBe(true);
    expect(h.nomorSerupa).toContain("LP-1");
    expect(h.alasan).toContain("menanganinya bersamaan");
    // Tidak boleh menuduh.
    expect(h.alasan?.toLowerCase()).not.toContain("spam");
  });

  it("menyebut pengiriman ganda saat pelapornya sama", () => {
    const h = cariDugaanGanda(baru, [tiket({ nomor: "LP-9", pelaporId: "warga-a" })]);
    expect(h.adaDugaan).toBe(true);
    expect(h.alasan).toContain("LP-9");
    // Laporannya tetap dicatat; ini penanda, bukan penolakan.
    expect(h.alasan).toContain("tetap dicatat");
  });

  it("tidak menandai apa pun bila laporan baru tanpa koordinat", () => {
    const h = cariDugaanGanda({ ...baru, titik: null }, [tiket({ nomor: "LP-1" })]);
    expect(h.adaDugaan).toBe(false);
  });

  it("radius ganda jauh lebih ketat daripada radius wajar", () => {
    // Menjaga keduanya tidak tertukar saat disetel ulang nanti.
    expect(RADIUS_GANDA_M).toBeLessThan(RADIUS_WAJAR_M);
  });
});
