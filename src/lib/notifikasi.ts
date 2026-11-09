import { log } from "./log.js";

/**
 * Klien layanan notifikasi (WhatsApp dan Telegram).
 *
 * ── Aturan utama: notifikasi TIDAK BOLEH menggagalkan pekerjaan utama ──
 *
 * Pemanggilnya ada di tengah penanganan permintaan HTTP — petugas yang baru
 * mengubah status tiket, atau warga yang baru menyelesaikan pembayaran. Kalau
 * fungsi di berkas ini melempar galat, yang gagal di layar mereka adalah
 * perubahan status atau pembayarannya, padahal keduanya sudah tersimpan di
 * basis data.
 *
 * Karena itu setiap fungsi di sini MENELAN galatnya sendiri dan hanya
 * mencatat. Tidak ada yang boleh melempar keluar. Kalau layanan notifikasi
 * mati, yang hilang hanya kabarnya; tiketnya tetap berubah.
 *
 * ── Kenapa tidak ditunggu ─────────────────────────────────────────────
 *
 * Layanan notifikasi membalas 202 setelah MENITIPKAN, bukan setelah
 * mengirim. Pengirimannya sendiri bisa tertunda menit-menitan kalau soket
 * WhatsApp sedang menyambung ulang. Menunggunya di sini tidak akan membuat
 * pesannya lebih cepat sampai, hanya membuat petugas menunggu lebih lama.
 */

const URL_LAYANAN = process.env.NOTIFIKASI_URL?.trim() || "";
const RAHASIA = process.env.NOTIFIKASI_SECRET?.trim() || "";

/** Batas waktu pendek: ini titipan, bukan pekerjaan yang perlu ditunggu. */
const BATAS_MS = 4000;

export type SaluranNotifikasi = "wa" | "telegram";

export function notifikasiAktif(): boolean {
  return URL_LAYANAN !== "" && RAHASIA !== "";
}

interface Titipan {
  /**
   * Kunci idempotensi.
   *
   * Harus diturunkan dari KEJADIANNYA, bukan dari waktu pemanggilan —
   * misalnya `tiket:JRN-00123:SELESAI`. Dengan begitu percobaan kedua
   * setelah jaringan putus tidak menghasilkan pesan kedua untuk warga.
   */
  kunci: string;
  saluran: SaluranNotifikasi;
  tujuan: string;
  pesan: string;
}

async function titip(isi: Titipan): Promise<boolean> {
  if (!notifikasiAktif()) {
    log.debug(
      { kunci: isi.kunci },
      "layanan notifikasi tidak dikonfigurasi, titipan dilewati",
    );
    return false;
  }

  const pembatal = AbortSignal.timeout(BATAS_MS);

  try {
    const balasan = await fetch(`${URL_LAYANAN}/kirim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notifikasi-secret": RAHASIA,
      },
      body: JSON.stringify(isi),
      signal: pembatal,
    });

    if (!balasan.ok) {
      log.warn(
        { kunci: isi.kunci, status: balasan.status },
        "layanan notifikasi menolak titipan",
      );
      return false;
    }

    return true;
  } catch (e) {
    log.warn(
      { kunci: isi.kunci, galat: e instanceof Error ? e.message : String(e) },
      "layanan notifikasi tidak bisa dihubungi",
    );
    return false;
  }
}

/**
 * Kirim ke semua saluran yang sudah disetujui warga.
 *
 * Yang menentukan saluran mana yang dipakai adalah DATA WARGA, bukan
 * pemanggil. `waOptIn` harus `true` dan `waNomor` harus ada; `telegramChatId`
 * yang terisi sudah berarti persetujuan karena warga sendiri yang menekan
 * Start di bot.
 *
 * Satu kejadian bisa menghasilkan dua pesan (WhatsApp dan Telegram) kalau
 * warga menautkan keduanya. Itu disengaja: ia memilih keduanya.
 */
export async function kabariWarga(
  penerima: {
    waNomor?: string | null;
    waOptIn?: boolean | null;
    telegramChatId?: string | null;
  },
  kunci: string,
  pesan: string,
): Promise<void> {
  const tugas: Promise<boolean>[] = [];

  if (penerima.waOptIn && penerima.waNomor) {
    tugas.push(
      titip({
        kunci: `${kunci}:wa`,
        saluran: "wa",
        tujuan: penerima.waNomor,
        pesan,
      }),
    );
  }

  if (penerima.telegramChatId) {
    tugas.push(
      titip({
        kunci: `${kunci}:tg`,
        saluran: "telegram",
        tujuan: penerima.telegramChatId,
        pesan,
      }),
    );
  }

  if (tugas.length === 0) return;

  // `allSettled`, bukan `all`: satu saluran yang gagal tidak boleh
  // membatalkan saluran lainnya.
  await Promise.allSettled(tugas);
}

/**
 * Tukar kode penghubung Telegram menjadi chat id.
 *
 * Berbeda dari `kabariWarga`, fungsi ini MEMANG ditunggu dan galatnya
 * dilaporkan: warga sedang menatap layar menunggu tautannya berhasil, jadi
 * diam-diam gagal di sini justru membingungkan.
 */
export async function tukarKodeTelegram(
  kode: string,
): Promise<{ ok: true; chatId: string } | { ok: false; pesan: string }> {
  if (!notifikasiAktif()) {
    return { ok: false, pesan: "Layanan notifikasi belum dikonfigurasi." };
  }

  try {
    const balasan = await fetch(`${URL_LAYANAN}/telegram/tukar-kode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notifikasi-secret": RAHASIA,
      },
      body: JSON.stringify({ kode }),
      signal: AbortSignal.timeout(BATAS_MS),
    });

    if (balasan.status === 404) {
      return {
        ok: false,
        pesan:
          "Kode tidak dikenal atau sudah kedaluwarsa. Kirim /start lagi ke bot Telegram untuk mendapat kode baru.",
      };
    }

    if (!balasan.ok) {
      return { ok: false, pesan: "Layanan notifikasi menolak permintaan." };
    }

    const isi = (await balasan.json()) as { chatId?: string };
    if (!isi.chatId) {
      return { ok: false, pesan: "Layanan notifikasi tidak mengirim chat id." };
    }

    return { ok: true, chatId: isi.chatId };
  } catch (e) {
    log.warn(
      { galat: e instanceof Error ? e.message : String(e) },
      "gagal menukar kode Telegram",
    );
    return {
      ok: false,
      pesan: "Layanan notifikasi sedang tidak bisa dihubungi. Coba lagi sebentar.",
    };
  }
}

/**
 * Normalisasi nomor WhatsApp Indonesia ke format `62...`.
 *
 * Warga menuliskan nomornya dengan cara apa pun: `0851...`, `+62 851-...`,
 * `62851...`. Yang disimpan harus satu bentuk, kalau tidak nomor yang sama
 * tersimpan sebagai dua nilai berbeda dan pemeriksaan duplikat tidak pernah
 * cocok.
 */
export function normalkanNomorWa(mentah: string): string | null {
  const angka = mentah.replace(/\D/g, "");
  if (angka.length < 9 || angka.length > 15) return null;
  if (angka.startsWith("62")) return angka;
  if (angka.startsWith("0")) return `62${angka.slice(1)}`;
  if (angka.startsWith("8")) return `62${angka}`;
  return null;
}
