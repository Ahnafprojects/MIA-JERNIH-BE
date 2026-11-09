import { Bot } from "grammy";
import type { Logger } from "pino";

import { env } from "../env.js";
import type { HasilKirim, Pengirim } from "./jenis.js";

/**
 * Pengirim Telegram lewat Bot API resmi.
 *
 * Berbeda dari WhatsApp, jalur ini resmi dan tidak punya risiko pemblokiran
 * nomor. Kalau suatu saat WhatsApp bermasalah, Telegram yang menahan beban.
 *
 * ── Long polling, bukan webhook ───────────────────────────────────────
 *
 * Layanan ini sengaja TIDAK diekspos ke internet; ia hanya mendengarkan di
 * 127.0.0.1 dan dipanggil backend Jernih dari jaringan Docker yang sama.
 * Webhook menuntut alamat publik berHTTPS, yang berarti membuka satu pintu
 * lagi ke luar hanya demi menerima pembaruan. Long polling tidak menuntut
 * apa pun dari sisi jaringan.
 *
 * ── Kenapa warga harus memulai dulu ───────────────────────────────────
 *
 * Telegram tidak mengizinkan bot mengirim pesan pertama. Warga harus menekan
 * "Start" di botnya dulu, dan dari situ `chat.id` miliknya diketahui. Jadi
 * alurnya: warga menekan Start, bot membalas dengan kode penghubung, warga
 * menempelkan kode itu di portal. Tanpa langkah itu tidak ada cara sah untuk
 * tahu chat id seseorang.
 */
export class PengirimTelegram implements Pengirim {
  readonly saluran = "telegram" as const;

  private bot: Bot | null = null;
  private berjalan = false;
  private namaBot: string | null = null;

  /**
   * Kode penghubung sementara: kode → chat id.
   *
   * Disimpan di memori dan sengaja berumur pendek. Yang menyimpan kaitan
   * permanen antara warga dan chat id adalah basis data Jernih, bukan
   * layanan ini — layanan ini tidak punya dan tidak boleh punya gambaran
   * siapa penggunanya.
   */
  private readonly kodePenghubung = new Map<
    string,
    { chatId: number; kedaluwarsa: number }
  >();

  constructor(private readonly log: Logger) {}

  siap(): boolean {
    return this.berjalan;
  }

  keadaan(): Record<string, unknown> {
    return {
      berjalan: this.berjalan,
      namaBot: this.namaBot,
      kodeMenunggu: this.kodePenghubung.size,
    };
  }

  async mulai(): Promise<void> {
    if (!env.telegramToken) {
      this.log.warn(
        "TELEGRAM_BOT_TOKEN kosong, saluran Telegram dimatikan. Ini bukan galat.",
      );
      return;
    }

    const bot = new Bot(env.telegramToken);
    this.bot = bot;

    bot.command("start", async (ctx) => {
      const chatId = ctx.chat.id;
      const kode = String(Math.floor(100000 + Math.random() * 900000));
      this.kodePenghubung.set(kode, {
        chatId,
        kedaluwarsa: Date.now() + 10 * 60 * 1000,
      });

      await ctx.reply(
        [
          "Halo! Ini bot notifikasi *Jernih*.",
          "",
          "Supaya kabar pengaduan dan token air Anda bisa dikirim ke sini,",
          "masukkan kode berikut di portal Jernih pada halaman Akun:",
          "",
          `*${kode}*`,
          "",
          "Kode berlaku 10 menit.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    });

    bot.command("berhenti", async (ctx) => {
      await ctx.reply(
        "Baik. Buka halaman Akun di portal Jernih lalu lepas tautan Telegram untuk berhenti menerima kabar.",
      );
    });

    bot.catch((err) => {
      this.log.error({ err: err.message }, "galat pada bot Telegram");
    });

    // `start()` tidak pernah selesai selama botnya hidup, jadi JANGAN
    // di-await. Menunggunya akan menggantung proses sebelum server HTTP
    // sempat mendengarkan.
    void bot.start({
      onStart: (info) => {
        this.berjalan = true;
        this.namaBot = info.username;
        this.log.info({ bot: info.username }, "bot Telegram berjalan");
      },
    });
  }

  /** Dipakai backend untuk menukar kode jadi chat id saat warga menautkan. */
  tukarKode(kode: string): number | null {
    const isi = this.kodePenghubung.get(kode);
    if (!isi) return null;
    if (Date.now() > isi.kedaluwarsa) {
      this.kodePenghubung.delete(kode);
      return null;
    }
    this.kodePenghubung.delete(kode);
    return isi.chatId;
  }

  async kirim(tujuan: string, pesan: string): Promise<HasilKirim> {
    if (!this.bot || !this.berjalan) {
      return {
        terkirim: false,
        bolehUlang: true,
        galat: "Bot Telegram belum berjalan.",
      };
    }

    /*
     * Dua bentuk tujuan diterima, dan keduanya memang dipakai:
     *
     *   - ANGKA   → chat id pribadi warga, hasil menukar kode penghubung.
     *   - @nama   → username channel pengumuman, mis. `@JernihInfo`.
     *
     * Versi pertama hanya menerima angka, dan akibatnya seluruh pengumuman
     * ke channel ditolak dengan "harus chat id berupa angka" — padahal
     * channel memang tidak punya chat id numerik yang bisa ditebak, dan
     * username-nya justru bentuk resmi yang dianjurkan Bot API.
     *
     * Keduanya dibedakan di sini, bukan di pemanggil, supaya pemanggil tidak
     * perlu tahu bedanya sama sekali.
     */
    const tujuanRapi = tujuan.trim();
    const keChannel = tujuanRapi.startsWith("@");

    if (!keChannel && !Number.isFinite(Number(tujuanRapi))) {
      return {
        terkirim: false,
        bolehUlang: false,
        galat: `Tujuan Telegram harus chat id berupa angka atau username channel berawalan @, diterima "${tujuan}".`,
      };
    }

    const chatId = keChannel ? tujuanRapi : Number(tujuanRapi);

    try {
      const hasil = await this.bot.api.sendMessage(chatId, pesan);
      return {
        terkirim: true,
        idPesan: String(hasil.message_id),
        bolehUlang: false,
      };
    } catch (e) {
      const pesanGalat = e instanceof Error ? e.message : String(e);
      /*
       * 403 berarti warga memblokir bot atau belum pernah menekan Start.
       * Itu keadaan permanen sampai ia sendiri yang mengubahnya, jadi
       * mengulanginya hanya menumpuk pekerjaan yang pasti gagal.
       */
      const permanen = /403|blocked|chat not found|deactivated/i.test(pesanGalat);
      return { terkirim: false, bolehUlang: !permanen, galat: pesanGalat };
    }
  }
}
