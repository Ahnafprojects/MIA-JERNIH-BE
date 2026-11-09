import type { Logger } from "pino";

import { env } from "./env.js";
import type { Pengirim, Saluran } from "./pengirim/jenis.js";

interface Pekerjaan {
  id: string;
  saluran: Saluran;
  tujuan: string;
  pesan: string;
  percobaan: number;
  jalankanPada: number;
}

/**
 * Antrean pesan keluar dengan coba-ulang.
 *
 * ── Kenapa tidak dikirim langsung ─────────────────────────────────────
 *
 * Pemanggilnya adalah backend Jernih, dan ia memanggil di tengah penanganan
 * permintaan HTTP milik petugas yang baru saja mengubah status tiket. Kalau
 * pengiriman dikerjakan di sana, satu soket WhatsApp yang sedang menyambung
 * ulang akan menahan permintaan petugas sampai habis waktu — dan yang gagal
 * di layar petugas adalah perubahan statusnya, padahal status itu sudah
 * tersimpan. Notifikasi tidak boleh menyandera pekerjaan utama.
 *
 * Jadi `POST /kirim` hanya menitipkan, lalu membalas 202.
 *
 * ── Kenapa ada idempotensi ────────────────────────────────────────────
 *
 * Backend boleh mencoba lagi kalau jaringannya putus sebelum balasan tiba.
 * Tanpa kunci idempotensi, percobaan kedua mengirim pesan kedua, dan warga
 * menerima dua kabar yang sama untuk satu kejadian. Kunci itu ditentukan
 * pemanggil dari hal yang memang unik — nomor tiket ditambah status barunya.
 */
export class Antrean {
  private readonly pekerjaan: Pekerjaan[] = [];
  private readonly sudahDiproses = new Map<string, number>();
  private berjalan = false;
  private readonly pengirim = new Map<Saluran, Pengirim>();

  /** Hitungan untuk /status. Angka yang tidak diukur tidak bisa dipercaya. */
  private statistik = { masuk: 0, terkirim: 0, gagalPermanen: 0, dibuang: 0 };

  constructor(private readonly log: Logger) {}

  daftarkan(p: Pengirim): void {
    this.pengirim.set(p.saluran, p);
  }

  keadaan(): Record<string, unknown> {
    return {
      antre: this.pekerjaan.length,
      ...this.statistik,
      pengirim: Object.fromEntries(
        [...this.pengirim.entries()].map(([s, p]) => [
          s,
          { siap: p.siap(), ...p.keadaan() },
        ]),
      ),
    };
  }

  /** @returns true bila baru dititipkan, false bila kunci ini sudah pernah. */
  titip(
    id: string,
    saluran: Saluran,
    tujuan: string,
    pesan: string,
  ): boolean {
    this.bersihkanIdemLama();
    if (this.sudahDiproses.has(id)) return false;
    if (this.pekerjaan.some((p) => p.id === id)) return false;

    this.pekerjaan.push({
      id,
      saluran,
      tujuan,
      pesan,
      percobaan: 0,
      jalankanPada: Date.now(),
    });
    this.statistik.masuk += 1;
    void this.proses();
    return true;
  }

  /**
   * Kunci idempotensi disimpan 24 jam, lalu dilupakan.
   *
   * Tanpa pembersihan, peta ini tumbuh selamanya dan menjadi kebocoran
   * memori yang baru terasa berminggu-minggu kemudian pada layanan yang
   * memang dirancang hidup terus.
   */
  private bersihkanIdemLama(): void {
    const batas = Date.now() - 24 * 60 * 60 * 1000;
    for (const [kunci, waktu] of this.sudahDiproses) {
      if (waktu < batas) this.sudahDiproses.delete(kunci);
    }
  }

  private async proses(): Promise<void> {
    if (this.berjalan) return;
    this.berjalan = true;

    try {
      while (this.pekerjaan.length > 0) {
        const sekarang = Date.now();
        const indeks = this.pekerjaan.findIndex(
          (p) => p.jalankanPada <= sekarang,
        );

        // Semua pekerjaan masih menunggu jeda coba-ulangnya.
        if (indeks === -1) {
          const paling = Math.min(...this.pekerjaan.map((p) => p.jalankanPada));
          await new Promise((r) =>
            setTimeout(r, Math.max(250, paling - sekarang)),
          );
          continue;
        }

        const [kerja] = this.pekerjaan.splice(indeks, 1);
        if (!kerja) continue;

        const pengirim = this.pengirim.get(kerja.saluran);
        if (!pengirim) {
          this.log.error(
            { id: kerja.id, saluran: kerja.saluran },
            "saluran tidak terdaftar, pesan dibuang",
          );
          this.statistik.dibuang += 1;
          continue;
        }

        if (!pengirim.siap()) {
          this.tundaUlang(kerja, "pengirim belum siap");
          continue;
        }

        const hasil = await pengirim.kirim(kerja.tujuan, kerja.pesan);

        if (hasil.terkirim) {
          this.sudahDiproses.set(kerja.id, Date.now());
          this.statistik.terkirim += 1;
          this.log.info(
            { id: kerja.id, saluran: kerja.saluran, idPesan: hasil.idPesan },
            "terkirim",
          );
          continue;
        }

        if (!hasil.bolehUlang) {
          /*
           * Gagal permanen TETAP dicatat sebagai sudah diproses.
           *
           * Kalau tidak, backend yang mengirim ulang kunci yang sama akan
           * mengantre lagi pekerjaan yang sudah pasti gagal, berulang kali,
           * untuk nomor yang memang tidak terdaftar di WhatsApp.
           */
          this.sudahDiproses.set(kerja.id, Date.now());
          this.statistik.gagalPermanen += 1;
          this.log.warn(
            { id: kerja.id, galat: hasil.galat },
            "gagal permanen, tidak diulang",
          );
          continue;
        }

        this.tundaUlang(kerja, hasil.galat ?? "tidak diketahui");
      }
    } finally {
      this.berjalan = false;
    }
  }

  private tundaUlang(kerja: Pekerjaan, alasan: string): void {
    kerja.percobaan += 1;

    if (kerja.percobaan >= env.maksPercobaan) {
      this.statistik.dibuang += 1;
      this.log.error(
        { id: kerja.id, percobaan: kerja.percobaan, alasan },
        "menyerah setelah percobaan maksimum",
      );
      return;
    }

    // Mundur eksponensial, dibatasi 5 menit. WhatsApp yang sedang menyambung
    // ulang butuh waktu, dan mencecarnya tiap detik tidak mempercepat apa pun.
    const jeda = Math.min(5 * 60_000, 2 ** kerja.percobaan * 1_000);
    kerja.jalankanPada = Date.now() + jeda;
    this.pekerjaan.push(kerja);

    this.log.warn(
      { id: kerja.id, percobaan: kerja.percobaan, jedaMs: jeda, alasan },
      "ditunda untuk dicoba lagi",
    );
  }
}
