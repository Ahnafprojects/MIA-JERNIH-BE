import { mkdirSync } from "node:fs";

import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import QRCode from "qrcode";

import { env } from "../env.js";
import type { HasilKirim, Pengirim } from "./jenis.js";

/**
 * Pengirim WhatsApp lewat Baileys.
 *
 * ── Nomor yang dipakai nomor sungguhan ────────────────────────────────
 *
 * Soket ini memegang sesi WhatsApp milik nomor bisnis tim. Dua hal yang
 * mengikat dan jangan dilonggarkan:
 *
 * 1. Pesan keluar DIJEDA (`JEDA_KIRIM_MS`). Mengirim beruntun adalah pola
 *    paling cepat dikenali sebagai robot.
 * 2. Nomor tujuan DIPERIKSA dulu lewat `onWhatsApp()`. Mengirim ke nomor
 *    yang tidak terdaftar berkali-kali adalah perilaku khas spam.
 *
 * ── Sesi harus bertahan ───────────────────────────────────────────────
 *
 * Kredensial pemasangan disimpan di `WA_SESI_DIR`, dan direktori itu WAJIB
 * berupa volume. Kalau ia ikut hilang tiap kontainer dibuat ulang, tiap
 * penyebaran menuntut pemindaian QR ulang — dan penyebaran terjadi pada
 * setiap push ke `main`.
 */
export class PengirimWa implements Pengirim {
  readonly saluran = "wa" as const;

  private soket: WASocket | null = null;
  private tersambung = false;
  private qrTerakhir: string | null = null;
  private alasanBerhenti: string | null = null;
  private waktuKirimTerakhir = 0;
  private menyambung = false;

  constructor(private readonly log: Logger) {}

  siap(): boolean {
    return this.tersambung;
  }

  keadaan(): Record<string, unknown> {
    return {
      tersambung: this.tersambung,
      menungguPemindaianQr: this.qrTerakhir !== null,
      alasanBerhenti: this.alasanBerhenti,
    };
  }

  /** QR pemasangan sebagai data URL PNG, atau null kalau sudah tersambung. */
  async qrPng(): Promise<string | null> {
    if (!this.qrTerakhir) return null;
    return QRCode.toDataURL(this.qrTerakhir, { margin: 1, width: 320 });
  }

  /** Muatan QR mentah, untuk digambar sebagai teks di terminal. */
  qrMentah(): string | null {
    return this.qrTerakhir;
  }

  async mulai(): Promise<void> {
    if (this.menyambung) return;
    this.menyambung = true;

    mkdirSync(env.waSesiDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(env.waSesiDir);
    const { version } = await fetchLatestBaileysVersion();

    this.log.info({ version }, "menyambung ke WhatsApp");

    const soket = makeWASocket({
      version,
      auth: state,
      // Baileys mencetak QR sendiri ke stdout kalau ini true. Dimatikan
      // karena QR-nya disajikan lewat endpoint, dan log kontainer bukan
      // tempat yang enak untuk memindai.
      printQRInTerminal: false,
      // Riwayat lama tidak diperlukan: layanan ini hanya mengirim.
      // Mengunduhnya hanya memakan memori di server yang swap-nya sudah
      // terpakai.
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: this.log.child({ bagian: "baileys" }) as never,
    });

    this.soket = soket;
    soket.ev.on("creds.update", saveCreds);

    soket.ev.on("connection.update", (pembaruan) => {
      const { connection, lastDisconnect, qr } = pembaruan;

      if (qr) {
        this.qrTerakhir = qr;
        this.log.warn(
          "WhatsApp menunggu pemindaian QR. Buka GET /qr untuk memindainya.",
        );
      }

      if (connection === "open") {
        this.tersambung = true;
        this.qrTerakhir = null;
        this.alasanBerhenti = null;
        this.log.info(
          { nomor: soket.user?.id },
          "WhatsApp tersambung",
        );
      }

      if (connection === "close") {
        this.tersambung = false;
        this.menyambung = false;

        const kode = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;

        /*
         * `loggedOut` TIDAK boleh disambung ulang otomatis.
         *
         * Kode itu berarti sesinya dicabut dari ponsel, dan kredensial yang
         * tersimpan sudah tidak berlaku. Menyambung ulang dengan kredensial
         * mati hanya menghasilkan percobaan masuk beruntun dari satu alamat
         * IP — perilaku yang justru mempercepat nomornya diblokir.
         */
        if (kode === DisconnectReason.loggedOut) {
          this.alasanBerhenti =
            "Sesi dicabut dari ponsel. Hapus isi WA_SESI_DIR lalu pindai QR lagi.";
          this.log.error(this.alasanBerhenti);
          return;
        }

        this.log.warn({ kode }, "WhatsApp terputus, menyambung ulang");
        setTimeout(() => void this.mulai(), 5_000);
      }
    });

    this.menyambung = false;
  }

  /**
   * Normalisasi nomor Indonesia ke format yang dipahami WhatsApp.
   *
   * `085121977860` dan `+62 851-2197-7860` adalah nomor yang sama, dan warga
   * menuliskannya dengan cara apa pun. Yang dikirim ke WhatsApp harus
   * `62...` tanpa tanda baca.
   */
  static normalkanNomor(mentah: string): string | null {
    const angka = mentah.replace(/\D/g, "");
    if (angka.length < 9) return null;
    if (angka.startsWith("62")) return angka;
    if (angka.startsWith("0")) return `62${angka.slice(1)}`;
    if (angka.startsWith("8")) return `62${angka}`;
    return null;
  }

  private async tahanLaju(): Promise<void> {
    const selisih = Date.now() - this.waktuKirimTerakhir;
    if (selisih < env.jedaKirimMs) {
      await new Promise((r) => setTimeout(r, env.jedaKirimMs - selisih));
    }
    this.waktuKirimTerakhir = Date.now();
  }

  async kirim(tujuan: string, pesan: string): Promise<HasilKirim> {
    if (!this.soket || !this.tersambung) {
      return {
        terkirim: false,
        bolehUlang: true,
        galat: "WhatsApp belum tersambung.",
      };
    }

    const nomor = PengirimWa.normalkanNomor(tujuan);
    if (!nomor) {
      return {
        terkirim: false,
        bolehUlang: false,
        galat: `Nomor "${tujuan}" tidak bisa dibaca sebagai nomor Indonesia.`,
      };
    }

    const jid = `${nomor}@s.whatsapp.net`;

    try {
      const cek = await this.soket.onWhatsApp(jid);
      if (!cek?.[0]?.exists) {
        return {
          terkirim: false,
          bolehUlang: false,
          galat: `Nomor ${nomor} tidak terdaftar di WhatsApp.`,
        };
      }

      await this.tahanLaju();
      const hasil = await this.soket.sendMessage(jid, { text: pesan });

      return { terkirim: true, idPesan: hasil?.key?.id ?? undefined, bolehUlang: false };
    } catch (e) {
      return {
        terkirim: false,
        bolehUlang: true,
        galat: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
