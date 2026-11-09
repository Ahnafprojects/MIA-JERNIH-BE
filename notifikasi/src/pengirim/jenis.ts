/**
 * Antarmuka pengirim.
 *
 * ── Kenapa ada lapisan ini ────────────────────────────────────────────
 *
 * WhatsApp di sini dikirim lewat Baileys, yaitu otomasi WhatsApp Web yang
 * TIDAK resmi. Itu keputusan sadar tim, dan nomornya sudah dipakai di
 * layanan serupa, tetapi risikonya tetap ada: kalau suatu saat nomor itu
 * diblokir, penggantinya adalah WhatsApp Cloud API yang resmi.
 *
 * Antarmuka ini yang membuat pergantian itu tidak membongkar apa pun.
 * Backend Jernih memanggil `POST /kirim` dan tidak pernah tahu pesannya
 * berangkat lewat apa. Mengganti Baileys dengan Cloud API berarti menulis
 * satu berkas baru di folder ini dan menukar pendaftarannya di `server.ts`
 * — tanpa satu baris pun berubah di sisi backend.
 */

export type Saluran = "wa" | "telegram";

export interface HasilKirim {
  terkirim: boolean;
  /** Id pesan dari penyedia, bila ada. Berguna untuk menelusuri keluhan. */
  idPesan?: string;
  /**
   * Boleh dicoba lagi?
   *
   * Dibedakan dari sekadar gagal, dan bedanya menentukan. Jaringan putus
   * boleh dicoba lagi; nomor yang tidak terdaftar di WhatsApp tidak akan
   * pernah berhasil berapa kali pun diulang, dan mengantrekannya hanya
   * menumpuk pekerjaan yang pasti gagal.
   */
  bolehUlang: boolean;
  galat?: string;
}

export interface Pengirim {
  readonly saluran: Saluran;
  /** Siap menerima pesan? Antrean menahan kirim selama ini false. */
  siap(): boolean;
  /** Keterangan keadaan untuk endpoint /status. */
  keadaan(): Record<string, unknown>;
  kirim(tujuan: string, pesan: string): Promise<HasilKirim>;
}
