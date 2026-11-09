/**
 * Kunci idempotensi, teks pesan, dan penyaringan persetujuan warga.
 *
 * Tiga hal yang diuji di sini punya akibat nyata kalau salah, dan tak satu
 * pun ketahuan dari `typecheck`:
 *
 *   1. Kunci yang diturunkan dari jam, bukan dari kejadiannya, membuat
 *      percobaan ulang setelah jaringan putus mengirim pesan kedua.
 *   2. Kunci saldo tanpa tanggal membuat satu saldo yang duduk di bawah
 *      ambang memicu pesan pada setiap pembacaan `/live`, yaitu tiap lima
 *      detik.
 *   3. Mengirim ke warga yang tidak menyetujui membuat nomor bisnis tim
 *      dilaporkan sebagai spam lalu diblokir WhatsApp.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { kabariWarga, notifikasiAktif } from "../src/lib/notifikasi.js";
import {
  kunciSaldoMenipis,
  kunciTiket,
  kunciTransaksi,
  pesanPembelianLunas,
  pesanSaldoMenipis,
  pesanTiketDiperbarui,
} from "../src/lib/pesan-notifikasi.js";

const APP = "https://jernih.biz.id";

describe("kunci idempotensi", () => {
  it("tiket: diturunkan dari nomor dan status, bukan dari waktu", () => {
    const a = kunciTiket("LP-2026-11-0027", "SELESAI");
    expect(a).toBe("tiket:LP-2026-11-0027:SELESAI");

    // Dipanggil lagi beberapa saat kemudian: HARUS sama persis.
    const b = kunciTiket("LP-2026-11-0027", "SELESAI");
    expect(b).toBe(a);
  });

  it("tiket: status berbeda menghasilkan kunci berbeda", () => {
    expect(kunciTiket("LP-2026-11-0027", "DIPROSES")).not.toBe(
      kunciTiket("LP-2026-11-0027", "SELESAI"),
    );
  });

  it("transaksi: satu invoice satu kunci", () => {
    expect(kunciTransaksi("INV-03870855")).toBe("transaksi:INV-03870855:LUNAS");
    expect(kunciTransaksi("INV-03870855")).toBe(kunciTransaksi("INV-03870855"));
  });

  it("saldo menipis: satu kunci per meter per hari", () => {
    const pagi = new Date("2026-11-09T01:00:00Z"); // 08.00 WIB
    const malam = new Date("2026-11-09T15:00:00Z"); // 22.00 WIB, hari yang sama
    expect(kunciSaldoMenipis("mtr-1", pagi)).toBe(
      kunciSaldoMenipis("mtr-1", malam),
    );
  });

  it("saldo menipis: hari berikutnya menghasilkan kunci baru", () => {
    const hariIni = new Date("2026-11-09T05:00:00Z");
    const besok = new Date("2026-11-10T05:00:00Z");
    expect(kunciSaldoMenipis("mtr-1", hariIni)).not.toBe(
      kunciSaldoMenipis("mtr-1", besok),
    );
  });

  it("saldo menipis: batas harinya WIB, bukan UTC", () => {
    /*
     * 2026-11-09T17:30:00Z masih 9 November di UTC, tetapi sudah pukul 00.30
     * tanggal 10 di Asia/Jakarta. Kalau tanggalnya dihitung UTC, warga yang
     * saldonya rendah semalaman menerima peringatan kedua pukul 07.00 WIB —
     * di tengah pagi yang sama.
     */
    const sebelumTengahMalamWib = new Date("2026-11-09T16:30:00Z"); // 23.30 WIB
    const sesudahTengahMalamWib = new Date("2026-11-09T17:30:00Z"); // 00.30 WIB (10 Nov)

    expect(kunciSaldoMenipis("mtr-1", sebelumTengahMalamWib)).toContain("11-09");
    expect(kunciSaldoMenipis("mtr-1", sesudahTengahMalamWib)).toContain("11-10");
  });

  it("saldo menipis: meter berbeda tidak saling menutup", () => {
    const t = new Date("2026-11-09T05:00:00Z");
    expect(kunciSaldoMenipis("mtr-1", t)).not.toBe(kunciSaldoMenipis("mtr-2", t));
  });
});

describe("teks pesan", () => {
  it("tiket: memuat nomor, kedua status, dan tautan lacak", () => {
    const teks = pesanTiketDiperbarui({
      nomorTiket: "LP-2026-11-0027",
      statusLama: "BARU",
      statusBaru: "DIPROSES",
      appUrl: APP,
    });

    expect(teks).toContain("LP-2026-11-0027");
    expect(teks).toContain("Baru");
    expect(teks).toContain("Sedang diproses");
    expect(teks).toContain(`${APP}/lacak?nomor=LP-2026-11-0027`);
  });

  it("tiket: catatan petugas ikut bila ada, hilang bila kosong", () => {
    const dengan = pesanTiketDiperbarui({
      nomorTiket: "LP-1",
      statusLama: "BARU",
      statusBaru: "SELESAI",
      catatan: "Pipa sudah diganti.",
      appUrl: APP,
    });
    expect(dengan).toContain("Pipa sudah diganti.");

    const tanpa = pesanTiketDiperbarui({
      nomorTiket: "LP-1",
      statusLama: "BARU",
      statusBaru: "SELESAI",
      catatan: "   ",
      appUrl: APP,
    });
    expect(tanpa).not.toContain("Catatan petugas");
  });

  it("tiket: catatan yang sangat panjang dipotong", () => {
    const panjang = "A".repeat(500);
    const teks = pesanTiketDiperbarui({
      nomorTiket: "LP-1",
      statusLama: "BARU",
      statusBaru: "SELESAI",
      catatan: panjang,
      appUrl: APP,
    });

    expect(teks).toContain("…");
    expect(teks.length).toBeLessThan(400);
  });

  it("pembelian: kode token tampil UTUH, tidak dibintangi", () => {
    const teks = pesanPembelianLunas({
      invoiceId: "INV-03870855",
      volumeL: 2000,
      jumlahRp: 15000,
      kodeToken: "4821773015",
      appUrl: APP,
    });

    expect(teks).toContain("4821773015");
    expect(teks).not.toContain("•");
    expect(teks).not.toContain("*****");
    expect(teks).toContain("INV-03870855");
  });

  it("angka memakai notasi Indonesia", () => {
    const teks = pesanPembelianLunas({
      invoiceId: "INV-1",
      volumeL: 10000,
      jumlahRp: 75000,
      kodeToken: "1234",
      appUrl: APP,
    });

    // Titik sebagai pemisah ribuan, bukan koma.
    expect(teks).toContain("10.000 liter");
    expect(teks).toContain("Rp 75.000");
  });

  it("saldo menipis: memuat sisa, ambang, dan tautan beli", () => {
    const teks = pesanSaldoMenipis({
      serialMeter: "JRN-10000",
      sisaSaldoL: 80,
      ambangL: 100,
      appUrl: APP,
    });

    expect(teks).toContain("JRN-10000");
    expect(teks).toContain("80 liter");
    expect(teks).toContain("100 liter");
    expect(teks).toContain(`${APP}/beli`);
  });

  it("tidak memakai markdown, karena Telegram dikirim tanpa parse_mode", () => {
    /*
     * WhatsApp merender `*tebal*`; `PengirimTelegram.kirim` memanggil
     * `sendMessage` tanpa `parse_mode`, jadi Telegram menampilkan tanda
     * bintangnya mentah. Satu teks yang sama tidak boleh terlihat rapi di satu
     * saluran dan berantakan di saluran lain.
     */
    const semua = [
      pesanTiketDiperbarui({
        nomorTiket: "LP-1",
        statusLama: "BARU",
        statusBaru: "SELESAI",
        catatan: "selesai",
        appUrl: APP,
      }),
      pesanPembelianLunas({
        invoiceId: "INV-1",
        volumeL: 500,
        jumlahRp: 3750,
        kodeToken: "1234",
        appUrl: APP,
      }),
      pesanSaldoMenipis({
        serialMeter: "JRN-1",
        sisaSaldoL: 10,
        ambangL: 100,
        appUrl: APP,
      }),
    ];

    for (const teks of semua) {
      expect(teks).not.toMatch(/\*/);
      expect(teks).not.toMatch(/_[^\s]/);
      // Gaya bahasa proyek: tanpa em dash.
      expect(teks).not.toContain("—");
    }
  });
});

describe("penyaringan persetujuan warga", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Menangkap setiap permintaan yang dikirim `kabariWarga`. */
  function sadapFetch(): { panggilan: Array<{ url: string; isi: unknown }> } {
    const panggilan: Array<{ url: string; isi: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opsi: { body?: string }) => {
        panggilan.push({
          url: String(url),
          isi: opsi?.body ? JSON.parse(opsi.body) : null,
        });
        return new Response(JSON.stringify({ dititipkan: true, baru: true }), {
          status: 202,
        });
      }),
    );
    return { panggilan };
  }

  it("layanan dianggap terkonfigurasi selama pengujian", () => {
    // Kalau ini false, seluruh uji di blok ini lolos tanpa menguji apa pun.
    expect(notifikasiAktif()).toBe(true);
  });

  it("warga tanpa waOptIn TIDAK dikirimi, walau nomornya terisi", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga(
      { waNomor: "6281252961135", waOptIn: false, telegramChatId: null },
      "tiket:LP-1:SELESAI",
      "halo",
    );

    expect(panggilan).toHaveLength(0);
  });

  it("warga dengan waOptIn tetapi tanpa nomor TIDAK dikirimi", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga(
      { waNomor: null, waOptIn: true, telegramChatId: null },
      "tiket:LP-1:SELESAI",
      "halo",
    );

    expect(panggilan).toHaveLength(0);
  });

  it("warga tanpa saluran apa pun TIDAK dikirimi", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga({}, "tiket:LP-1:SELESAI", "halo");

    expect(panggilan).toHaveLength(0);
  });

  it("waOptIn dengan nomor: dikirim lewat WhatsApp", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga(
      { waNomor: "6281252961135", waOptIn: true, telegramChatId: null },
      "tiket:LP-1:SELESAI",
      "halo",
    );

    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]!.isi).toMatchObject({
      saluran: "wa",
      tujuan: "6281252961135",
      kunci: "tiket:LP-1:SELESAI:wa",
    });
  });

  it("telegramChatId terisi sudah berarti persetujuan", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga(
      { waNomor: null, waOptIn: false, telegramChatId: "12345" },
      "tiket:LP-1:SELESAI",
      "halo",
    );

    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]!.isi).toMatchObject({
      saluran: "telegram",
      tujuan: "12345",
    });
  });

  it("dua saluran tertaut menghasilkan dua pesan dengan kunci berbeda", async () => {
    const { panggilan } = sadapFetch();

    await kabariWarga(
      { waNomor: "6281252961135", waOptIn: true, telegramChatId: "12345" },
      "transaksi:INV-1:LUNAS",
      "halo",
    );

    expect(panggilan).toHaveLength(2);
    const kunci = panggilan.map((p) => (p.isi as { kunci: string }).kunci).sort();
    expect(kunci).toEqual([
      "transaksi:INV-1:LUNAS:tg",
      "transaksi:INV-1:LUNAS:wa",
    ]);
  });

  it("kegagalan jaringan ditelan, tidak dilempar keluar", async () => {
    /*
     * Ini jaminan yang menahan seluruh rancangan: pemanggilnya ada di tengah
     * permintaan HTTP petugas yang baru mengubah status tiket. Kalau fungsi
     * ini melempar, yang gagal di layar petugas adalah perubahan statusnya,
     * padahal status itu sudah tersimpan di basis data.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(
      kabariWarga(
        { waNomor: "6281252961135", waOptIn: true, telegramChatId: "12345" },
        "tiket:LP-1:SELESAI",
        "halo",
      ),
    ).resolves.toBeUndefined();
  });

  it("balasan non-2xx juga ditelan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("tidak", { status: 500 })),
    );

    await expect(
      kabariWarga(
        { waNomor: "6281252961135", waOptIn: true, telegramChatId: null },
        "tiket:LP-1:SELESAI",
        "halo",
      ),
    ).resolves.toBeUndefined();
  });
});
