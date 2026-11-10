import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "pino";

import { env } from "./env.js";
import type { HasilKirim, Pengirim, Saluran } from "./pengirim/jenis.js";

/**
 * Batas waktu satu pengiriman.
 *
 * Dibuat longgar dengan sengaja. WhatsApp memeriksa nomor tujuan lebih dulu
 * lewat `onWhatsApp()` dan menahan laju 2,5 detik sebelum mengirim, jadi
 * satu pengiriman yang SEHAT pun bisa memakan beberapa detik. Batas yang
 * terlalu ketat akan mengulang pesan yang sebenarnya baik-baik saja.
 */
const BATAS_KIRIM_MS = 30_000;

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
  /** Pekerjaan yang sedang di tangan pengirim, ikut disimpan ke berkas. */
  private sedangDikirim: Pekerjaan | null = null;
  private penandaSimpan: NodeJS.Timeout | null = null;

  /** Hitungan untuk /status. Angka yang tidak diukur tidak bisa dipercaya. */
  private statistik = { masuk: 0, terkirim: 0, gagalPermanen: 0, dibuang: 0 };

  constructor(private readonly log: Logger) {}

  /* ── Ketahanan terhadap restart ──────────────────────────────────────
   *
   * Antrean ini dulunya hanya hidup di memori. Kontainernya dibuat ulang
   * pada SETIAP push ke `main`, dan setiap pembuatan ulang membuang pesan
   * yang masih antre, termasuk yang sedang menunggu WhatsApp tersambung
   * kembali. Yang hilang paling sering justru yang paling ditunggu: struk
   * berisi kode token yang baru dibeli.
   *
   * Sekarang isinya disalin ke `ANTREAN_BERKAS` di volume `/data`, yang
   * sama dengan tempat sesi WhatsApp, lalu dibaca lagi saat layanan mulai.
   * Kunci idempotensi ikut disimpan, supaya backend yang mengirim ulang
   * titipan sesudah restart tidak membuat pesan kedua.
   *
   * Penulisannya atomik (berkas sementara lalu `rename`). Tanpa itu, proses
   * yang mati di tengah penulisan meninggalkan JSON terpotong, dan layanan
   * gagal membaca antreannya sendiri saat menyala lagi.
   */

  /** Pulihkan isi antrean dari berkas. Dipanggil sekali saat layanan mulai. */
  muat(): void {
    let mentah: string;
    try {
      mentah = readFileSync(env.antreanBerkas, "utf8");
    } catch {
      return; // Belum pernah disimpan: antrean memang kosong.
    }

    try {
      const isi = JSON.parse(mentah) as {
        pekerjaan?: Pekerjaan[];
        sudahDiproses?: [string, number][];
      };
      for (const p of isi.pekerjaan ?? []) {
        if (!this.pekerjaan.some((x) => x.id === p.id)) this.pekerjaan.push(p);
      }
      for (const [kunci, waktu] of isi.sudahDiproses ?? []) {
        this.sudahDiproses.set(kunci, waktu);
      }
      this.bersihkanIdemLama();
      this.log.info(
        { antre: this.pekerjaan.length, berkas: env.antreanBerkas },
        "antrean dipulihkan dari berkas",
      );
    } catch (e) {
      // Berkas rusak tidak boleh menghentikan layanan. Pesan lama hilang,
      // tetapi pesan baru tetap bisa dikirim.
      this.log.error(
        { err: String(e), berkas: env.antreanBerkas },
        "berkas antrean tidak terbaca, mulai dari kosong",
      );
    }

    if (this.pekerjaan.length > 0) void this.proses();
  }

  /** Tulis segera. Dipakai saat layanan diminta berhenti. */
  simpanSekarang(): void {
    if (this.penandaSimpan) {
      clearTimeout(this.penandaSimpan);
      this.penandaSimpan = null;
    }

    const isi = JSON.stringify({
      pekerjaan: this.sedangDikirim
        ? [this.sedangDikirim, ...this.pekerjaan]
        : this.pekerjaan,
      sudahDiproses: [...this.sudahDiproses.entries()],
    });

    try {
      mkdirSync(dirname(env.antreanBerkas), { recursive: true });
      const sementara = `${env.antreanBerkas}.tmp`;
      writeFileSync(sementara, isi, "utf8");
      renameSync(sementara, env.antreanBerkas);
    } catch (e) {
      this.log.error(
        { err: String(e), berkas: env.antreanBerkas },
        "antrean gagal disimpan ke berkas",
      );
    }
  }

  /**
   * Tulis sebentar lagi. Broadcast ke ratusan warga menitipkan ratusan
   * pesan dalam satu detik; menulis berkas sekali per pesan hanya membebani
   * disk tanpa menambah keamanan apa pun.
   */
  private simpanNanti(): void {
    if (this.penandaSimpan) return;
    this.penandaSimpan = setTimeout(() => {
      this.penandaSimpan = null;
      this.simpanSekarang();
    }, 250);
  }

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
    this.simpanNanti();
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

        this.sedangDikirim = kerja;
        let hasil: HasilKirim;
        try {
          hasil = await this.kirimBerbatas(pengirim, kerja);
        } finally {
          this.sedangDikirim = null;
          this.simpanNanti();
        }

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

  /**
   * Pengiriman dengan BATAS WAKTU.
   *
   * ── Kenapa ini ada ───────────────────────────────────────────────────
   *
   * Antrean ini memproses satu pekerjaan pada satu waktu. Tanpa batas waktu,
   * satu permintaan yang menggantung ke penyedia menahan SELURUH antrean
   * selamanya — dan diam-diam, karena tidak ada galat yang dilempar dan
   * tidak ada baris log yang ditulis.
   *
   * Terjadi sungguhan di produksi: tiga pesan dititipkan, satu tersangkut di
   * dalam `kirim`, dua menunggu di belakangnya, dan `/status` menunjukkan
   * `antre: 2` yang tidak bergerak dengan NOL baris "ditunda" maupun
   * "terkirim". Dari luar, fiturnya tampak sekadar "tidak jalan".
   *
   * Batasnya dipasang DI SINI, bukan di masing-masing pengirim, supaya
   * penyedia baru apa pun yang ditambahkan kelak ikut terlindungi tanpa
   * harus ingat memasangnya sendiri.
   *
   * Habisnya waktu dianggap BOLEH DIULANG: permintaan yang menggantung
   * biasanya soal jaringan, dan pesannya mungkin sebenarnya sudah sampai.
   * Kunci idempotensi di sisi penyedia tidak ada, jadi ada kemungkinan kecil
   * pesan ganda — itu pilihan yang disengaja, karena kabar yang sampai dua
   * kali jauh lebih baik daripada kabar yang tidak pernah sampai.
   */
  private async kirimBerbatas(
    pengirim: Pengirim,
    kerja: Pekerjaan,
  ): Promise<HasilKirim> {
    let penanda: NodeJS.Timeout | undefined;

    const batas = new Promise<HasilKirim>((selesai) => {
      penanda = setTimeout(
        () =>
          selesai({
            terkirim: false,
            bolehUlang: true,
            galat: `Pengiriman tidak selesai dalam ${BATAS_KIRIM_MS} ms.`,
          }),
        BATAS_KIRIM_MS,
      );
    });

    try {
      return await Promise.race([
        pengirim.kirim(kerja.tujuan, kerja.pesan),
        batas,
      ]);
    } finally {
      // WAJIB. Tanpa ini penanda waktunya tetap hidup setelah pengiriman
      // berhasil, dan prosesnya menahan satu timer per pesan yang pernah
      // dikirim.
      if (penanda) clearTimeout(penanda);
    }
  }

  private tundaUlang(kerja: Pekerjaan, alasan: string): void {
    this.simpanNanti();
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
