/**
 * Unduhan data mentah: empat kumpulan data, dua format.
 *
 *   GET /api/publik/unduh?set=harian&format=csv&rentang=30
 *
 * Isinya DITURUNKAN dari fungsi yang sama dengan yang menyuapi halaman
 * (`./neraca.js`), bukan disalin ulang. Berkas unduhan yang isinya berbeda
 * sedikit dari angka di layar lebih merusak kepercayaan daripada tidak
 * menyediakan unduhan sama sekali — orang pertama yang mencocokkannya akan
 * menyimpulkan salah satunya dikarang, dan ia tidak akan tahu yang mana.
 */
import {
  META,
  deretHarian,
  neracaAir,
  perZonaNeraca,
  trenBulanan,
  type MetaData,
} from "./neraca.js";

type Nilai = string | number;

export interface Kolom {
  kunci: string;
  label: string;
  satuan?: string;
}

export interface Kumpulan {
  kunci: string;
  judul: string;
  /** `true` bila isinya berubah mengikuti rentang waktu yang dipilih. */
  ikutRentang: boolean;
  kolom: Kolom[];
  baris: Record<string, Nilai>[];
}

/* ── Kumpulan data ──────────────────────────────────────────────────── */

async function kumpulanHarian(hari: number): Promise<Kumpulan> {
  return {
    kunci: "harian",
    judul: "Ringkasan harian",
    ikutRentang: true,
    kolom: [
      { kunci: "tanggal", label: "Tanggal" },
      { kunci: "disalurkan_m3", label: "Air disalurkan", satuan: "m3" },
      { kunci: "tercatat_m3", label: "Air tercatat", satuan: "m3" },
      { kunci: "kehilangan_m3", label: "Kehilangan", satuan: "m3" },
      { kunci: "nrw_persen", label: "Kehilangan air (NRW)", satuan: "%" },
    ],
    baris: (await deretHarian(hari)).map((b) => ({
      tanggal: b.tanggal,
      disalurkan_m3: b.disalurkanM3,
      tercatat_m3: b.tercatatM3,
      kehilangan_m3: b.kehilanganM3,
      nrw_persen: b.nrwPct,
    })),
  };
}

async function kumpulanZona(hari: number): Promise<Kumpulan> {
  return {
    kunci: "zona",
    judul: "Rincian per zona",
    ikutRentang: true,
    kolom: [
      { kunci: "zona", label: "Zona distribusi" },
      { kunci: "disalurkan_m3", label: "Air disalurkan", satuan: "m3" },
      { kunci: "tercatat_m3", label: "Air tercatat", satuan: "m3" },
      { kunci: "nrw_persen", label: "Kehilangan air (NRW)", satuan: "%" },
    ],
    // `zonaId` sengaja TIDAK ikut: ia tidak berarti apa-apa di luar sistem ini
    // dan hanya menambah kolom yang membingungkan pembaca berkas.
    baris: (await perZonaNeraca(hari)).map((z) => ({
      zona: z.nama,
      disalurkan_m3: z.disalurkanM3,
      tercatat_m3: z.tercatatM3,
      nrw_persen: z.nrwPct,
    })),
  };
}

async function kumpulanNeraca(hari: number): Promise<Kumpulan> {
  const n = await neracaAir(hari);
  return {
    kunci: "neraca",
    judul: "Neraca air",
    ikutRentang: true,
    kolom: [
      { kunci: "kelompok", label: "Kelompok" },
      { kunci: "komponen", label: "Komponen" },
      { kunci: "volume_m3", label: "Volume", satuan: "m3" },
      {
        kunci: "porsi_persen",
        label: "Porsi dari seluruh kehilangan",
        satuan: "%",
      },
    ],
    baris: n.kelompok.flatMap((g) =>
      g.komponen.map((k) => ({
        kelompok: g.nama,
        komponen: k.nama,
        volume_m3: k.volumeM3,
        porsi_persen: k.porsiPct,
      })),
    ),
  };
}

async function kumpulanBulanan(): Promise<Kumpulan> {
  return {
    kunci: "bulanan",
    judul: "Tren bulanan 12 bulan",
    ikutRentang: false,
    kolom: [
      { kunci: "bulan", label: "Bulan" },
      { kunci: "disalurkan_m3", label: "Air disalurkan", satuan: "m3" },
      { kunci: "tercatat_m3", label: "Air tercatat", satuan: "m3" },
      { kunci: "kehilangan_m3", label: "Kehilangan", satuan: "m3" },
      { kunci: "nrw_persen", label: "Kehilangan air (NRW)", satuan: "%" },
    ],
    baris: (await trenBulanan()).map((b) => ({
      bulan: b.bulan,
      disalurkan_m3: b.disalurkanM3,
      tercatat_m3: b.tercatatM3,
      kehilangan_m3: b.kehilanganM3,
      nrw_persen: b.nrwPct,
    })),
  };
}

const PEMBUAT: Record<string, (hari: number) => Promise<Kumpulan>> = {
  harian: kumpulanHarian,
  zona: kumpulanZona,
  neraca: kumpulanNeraca,
  bulanan: () => kumpulanBulanan(),
};

export const SET_TERSEDIA = Object.keys(PEMBUAT);

export const buatKumpulan = (
  set: string,
  hari: number,
): Promise<Kumpulan> | null => PEMBUAT[set]?.(hari) ?? null;

/* ── CSV ────────────────────────────────────────────────────────────── */

/**
 * CSV menurut RFC 4180: pemisah koma, TITIK desimal, akhir baris CRLF.
 *
 * Bukan format Indonesia, dan itu disengaja. Berkas ini dibuat untuk dibaca
 * ULANG oleh alat lain — pandas, R, Google Sheets, QGIS — dan semuanya membaca
 * RFC 4180 tanpa disetel. Memakai titik koma dan koma desimal akan membuatnya
 * nyaman di satu aplikasi dan rusak di semua yang lain. Pilihan ini ditulis apa
 * adanya di halaman, jadi tidak ada yang tertipu.
 *
 * BOM UTF-8 tetap dipasang: tanpanya Excel di Windows membaca "m³" dan nama
 * zona berhuruf non-ASCII sebagai sampah.
 */
const BOM = "﻿";

function sel(v: Nilai): string {
  const s = typeof v === "number" ? String(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function keCsv(k: Kumpulan): string {
  // Nama kolom sudah membawa satuannya sendiri (`volume_m3`, `nrw_persen`),
  // jadi tidak ditempeli satuan sekali lagi. Baris kepala yang berisi
  // "volume_m3 (m3)" harus dibersihkan tangan sebelum dipakai di mana pun.
  const kepala = k.kolom.map((c) => sel(c.kunci));
  const baris = k.baris.map((b) => k.kolom.map((c) => sel(b[c.kunci] ?? "")));
  return BOM + [kepala, ...baris].map((x) => x.join(",")).join("\r\n") + "\r\n";
}

/* ── Nama berkas ────────────────────────────────────────────────────── */

/**
 * Tanggal hari ini menurut waktu SETEMPAT, bukan UTC.
 *
 * `toISOString().slice(0,10)` salah sehari setiap kali berkas diunduh sebelum
 * pukul 07.00 WIB: namanya tertulis "…-2026-10-23" sementara baris terakhir di
 * dalamnya bertanggal 2026-10-24. Nama berkas yang membantah isinya sendiri
 * adalah hal pertama yang membuat orang curiga pada seluruh angkanya.
 */
function hariIni(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function namaBerkas(k: Kumpulan, hari: number, format: string): string {
  const bagian = [
    "jernih",
    k.kunci,
    k.ikutRentang ? `${hari}hari` : null,
    hariIni(),
  ].filter(Boolean);
  return `${bagian.join("-")}.${format}`;
}

export interface BungkusJson {
  set: string;
  judul: string;
  rentangHari: number | null;
  dibuatPada: string;
  jumlahBaris: number;
  kolom: Kolom[];
  data: Record<string, Nilai>[];
  meta: MetaData;
}

export function keJson(k: Kumpulan, hari: number): BungkusJson {
  return {
    set: k.kunci,
    judul: k.judul,
    rentangHari: k.ikutRentang ? hari : null,
    dibuatPada: new Date().toISOString(),
    jumlahBaris: k.baris.length,
    kolom: k.kolom,
    data: k.baris,
    meta: META,
  };
}
