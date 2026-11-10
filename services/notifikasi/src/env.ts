/**
 * Konfigurasi layanan notifikasi.
 *
 * Gagal cepat kalau yang wajib kosong. Layanan pengirim pesan yang menyala
 * dengan konfigurasi setengah jadi adalah kegagalan paling mahal di sini:
 * ia menerima permintaan, membalas 200, lalu membuang pesannya diam-diam —
 * dan yang menunggu kabar adalah warga yang pipanya sedang bocor.
 */

function wajib(nama: string): string {
  const nilai = process.env[nama];
  if (!nilai || nilai.trim() === "") {
    throw new Error(
      `${nama} belum diatur. Layanan notifikasi berhenti supaya kegagalannya terlihat sekarang, bukan nanti saat ada pesan yang hilang.`,
    );
  }
  return nilai.trim();
}

function angka(nama: string, bawaan: number): number {
  const mentah = process.env[nama];
  if (!mentah) return bawaan;
  const n = Number(mentah);
  if (!Number.isFinite(n)) {
    throw new Error(`${nama} harus angka, diterima "${mentah}".`);
  }
  return n;
}

export const env = {
  port: angka("PORT", 5310),

  /**
   * Rahasia bersama dengan backend Jernih.
   *
   * SENGAJA tanpa nilai bawaan. Layanan ini bisa mengirim pesan ke nomor
   * WhatsApp sungguhan; kalau rahasianya punya nilai bawaan, siapa pun yang
   * bisa menjangkau portnya bisa memakai nomor itu.
   */
  rahasia: wajib("NOTIFIKASI_SECRET"),

  /** Telegram mati total kalau tokennya kosong, dan itu bukan galat. */
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",

  /** WhatsApp bisa dimatikan tanpa membongkar apa pun. */
  waAktif: (process.env.WA_AKTIF ?? "true").toLowerCase() !== "false",

  /**
   * Salinan antrean pesan di disk, supaya pesan yang belum terkirim tidak
   * hilang saat kontainer dibuat ulang. Harus berada di volume yang sama
   * dengan sesi WhatsApp.
   */
  antreanBerkas: process.env.ANTREAN_BERKAS?.trim() || "/data/antrean.json",

  /** Tempat menyimpan kredensial pemasangan WhatsApp. Harus volume. */
  waSesiDir: process.env.WA_SESI_DIR?.trim() || "/data/wa-sesi",

  /**
   * Jeda minimum antar pesan keluar, milidetik.
   *
   * Bukan untuk menghemat sumber daya. Otomasi WhatsApp yang mengirim
   * beruntun adalah pola yang paling cepat dikenali sebagai robot, dan
   * akibatnya nomornya diblokir. Ini nomor bisnis sungguhan milik tim.
   */
  jedaKirimMs: angka("JEDA_KIRIM_MS", 2500),

  /** Berapa kali pesan yang gagal dicoba ulang sebelum dianggap mati. */
  maksPercobaan: angka("MAKS_PERCOBAAN", 5),

  logLevel: process.env.LOG_LEVEL?.trim() || "info",
} as const;
