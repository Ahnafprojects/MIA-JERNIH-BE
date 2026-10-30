/**
 * Neraca air, statistik, dan unduhan.
 *
 * Yang diuji di sini bukan "apakah endpointnya hidup", melainkan apakah
 * angkanya KONSISTEN antar permukaan. Halaman depan, halaman statistik, dan
 * berkas yang diunduh menampilkan tiga potongan dari hitungan yang sama;
 * begitu salah satunya bergeser, seluruh klaim transparansi runtuh — dan
 * pergeseran semacam itu tidak pernah terlihat dari membaca kode.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { bagiTepat } from "../src/lib/neraca.js";

const app = buatApp();

/**
 * Memastikan ada bacaan meter induk untuk diuji.
 *
 * Tes ini tidak boleh bergantung pada urutan jalannya berkas tes lain: kalau
 * `seed.test.ts` kebetulan berjalan belakangan, seluruh berkas ini akan
 * menguji basis data kosong dan LULUS tanpa memeriksa apa pun. Jadi datanya
 * disiapkan sendiri di sini bila belum ada.
 */
beforeAll(async () => {
  if ((await prisma.neracaHarian.count()) > 0) return;

  const zona = await prisma.zona.upsert({
    where: { nama: "Zona Uji Neraca" },
    update: {},
    create: { nama: "Zona Uji Neraca" },
  });

  const baris = Array.from({ length: 120 }, (_, i) => {
    const d = new Date(Date.now() - i * 86_400_000);
    return {
      zonaId: zona.id,
      tanggal: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())),
      volumeIndukL: 1_000_000,
      volumeTercatatL: 800_000,
    };
  });
  await prisma.neracaHarian.createMany({ data: baris, skipDuplicates: true });
});

describe("bagiTepat — pembagian tanpa meter kubik yang menguap", () => {
  it("jumlah hasilnya kembali persis ke total, bukan mendekati", () => {
    // 997 dibagi delapan porsi ganjil adalah kasus yang membuat pembulatan
    // biasa meleset; itu sebabnya angka inilah yang diuji.
    const porsi = [41, 14, 7, 17, 9, 4, 5, 3];
    for (const total of [0, 1, 7, 997, 123_457]) {
      const hasil = bagiTepat(total, porsi);
      expect(hasil.reduce((a, b) => a + b, 0)).toBe(total);
      expect(hasil.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    }
  });

  it("total nol atau porsi kosong tidak menghasilkan NaN", () => {
    expect(bagiTepat(100, [0, 0])).toEqual([0, 0]);
    expect(bagiTepat(-5, [1, 1])).toEqual([0, 0]);
  });
});

describe("GET /api/publik/neraca-air", () => {
  it("rinciannya membagi habis kehilangan, sampai meter kubik terakhir", async () => {
    const res = await request(app).get("/api/publik/neraca-air?rentang=30");
    expect(res.status).toBe(200);

    const b = res.body;
    expect(b.rentangHari).toBe(30);

    // Tiga angka besar harus saling menutup. Kalau tidak, salah satunya
    // dihitung dari sumber yang berbeda.
    expect(b.totalDisalurkanM3 - b.totalTercatatM3).toBe(b.totalKehilanganM3);
    expect(b.totalDisalurkanM3).toBeGreaterThan(0);

    // Dan rinciannya harus menjumlah kembali ke angka besar itu.
    const jumlahKelompok = b.kelompok.reduce(
      (a: number, g: { volumeM3: number }) => a + g.volumeM3,
      0,
    );
    expect(jumlahKelompok).toBe(b.totalKehilanganM3);

    for (const g of b.kelompok) {
      const jumlahKomponen = g.komponen.reduce(
        (a: number, k: { volumeM3: number }) => a + k.volumeM3,
        0,
      );
      expect(jumlahKomponen).toBe(g.volumeM3);
    }
  });

  it("tren bulanan selalu 12 titik dan tidak bergantung pada rentang", async () => {
    const [a, c] = await Promise.all([
      request(app).get("/api/publik/neraca-air?rentang=7"),
      request(app).get("/api/publik/neraca-air?rentang=90"),
    ]);
    expect(a.body.bulanan).toHaveLength(12);
    // Arah setahun bukan sesuatu yang berubah karena seseorang menekan
    // tombol 7 hari.
    expect(a.body.bulanan).toEqual(c.body.bulanan);
  });

  it("rentang yang tidak dilayani jatuh ke 30 hari, bukan menjadi galat", async () => {
    for (const q of ["3", "9999", "abc", "-1"]) {
      const res = await request(app).get(`/api/publik/neraca-air?rentang=${q}`);
      expect(res.status).toBe(200);
      expect(res.body.rentangHari).toBe(30);
    }
  });

  it("batasan datanya ikut dikirim, bukan hanya ditulis di halaman", async () => {
    const res = await request(app).get("/api/publik/neraca-air");
    // Data terbuka tanpa daftar batasan adalah undangan untuk salah kutip.
    expect(res.body.meta.catatan.length).toBeGreaterThanOrEqual(5);
    expect(res.body.tolokUkur.some((t: { kunci: string }) => t.kunci === "target")).toBe(true);
  });
});

describe("GET /api/publik/statistik — kehilangan air tidak lagi null", () => {
  it("mengirim angka, bukan '—', dan ketiganya saling menutup", async () => {
    const res = await request(app).get("/api/publik/statistik?rentang=30");
    expect(res.status).toBe(200);

    const b = res.body;
    // Inilah regresi yang dijaga: ubin "Kehilangan air" di halaman depan
    // menampilkan "—" selama `nrwPct` null.
    expect(b.nrwPct).not.toBeNull();
    expect(b.volumeDisalurkanM3).not.toBeNull();
    expect(typeof b.nrwPct).toBe("number");
    expect(b.volumeDisalurkanM3).toBeGreaterThanOrEqual(b.volumeTercatatM3);

    expect(b.labels).toHaveLength(b.series[0].points.length);
    expect(b.series.map((s: { name: string }) => s.name)).toEqual([
      "Air disalurkan",
      "Air tercatat",
    ]);
  });

  it("angkanya sama persis dengan /neraca-air pada rentang yang sama", async () => {
    const [stat, neraca] = await Promise.all([
      request(app).get("/api/publik/statistik?rentang=90"),
      request(app).get("/api/publik/neraca-air?rentang=90"),
    ]);
    // Dua halaman berbeda yang menampilkan angka berbeda untuk hal yang sama
    // adalah hal pertama yang dicari orang pada portal transparansi.
    expect(stat.body.volumeDisalurkanM3).toBe(neraca.body.totalDisalurkanM3);
    expect(stat.body.volumeTercatatM3).toBe(neraca.body.totalTercatatM3);
    expect(stat.body.nrwPct).toBe(neraca.body.nrwPct);
  });
});

describe("GET /api/publik/unduh", () => {
  it("CSV memakai RFC 4180 dan barisnya sebanyak rentang yang diminta", async () => {
    const res = await request(app).get(
      "/api/publik/unduh?set=harian&format=csv&rentang=7",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("7hari");

    const teks = res.text;
    // BOM UTF-8 — tanpanya Excel di Windows membaca "m³" sebagai sampah.
    expect(teks.charCodeAt(0)).toBe(0xfeff);
    expect(teks).toContain("\r\n");

    const baris = teks.replace(/^﻿/, "").trim().split("\r\n");
    expect(baris[0]).toBe(
      "tanggal,disalurkan_m3,tercatat_m3,kehilangan_m3,nrw_persen",
    );
    expect(baris).toHaveLength(8); // 1 kepala + 7 hari
  });

  it("JSON membawa kolom, data, dan meta", async () => {
    const res = await request(app).get(
      "/api/publik/unduh?set=bulanan&format=json",
    );
    expect(res.status).toBe(200);
    expect(res.body.set).toBe("bulanan");
    // `bulanan` tidak mengikuti rentang, jadi rentangHari harus null — bukan
    // 30 yang akan membuat pembaca menyangka isinya terpotong sebulan.
    expect(res.body.rentangHari).toBeNull();
    expect(res.body.data).toHaveLength(12);
    expect(res.body.jumlahBaris).toBe(res.body.data.length);
    expect(res.body.meta.lisensi).toContain("CC BY 4.0");
  });

  it("isinya sama dengan yang ditampilkan halaman", async () => {
    const [unduh, neraca] = await Promise.all([
      request(app).get("/api/publik/unduh?set=neraca&format=json&rentang=30"),
      request(app).get("/api/publik/neraca-air?rentang=30"),
    ]);
    const jumlahUnduh = unduh.body.data.reduce(
      (a: number, r: { volume_m3: number }) => a + r.volume_m3,
      0,
    );
    expect(jumlahUnduh).toBe(neraca.body.totalKehilanganM3);
  });

  it("set dan format yang tidak dikenal ditolak 400 dengan pilihan yang ada", async () => {
    const resSet = await request(app).get("/api/publik/unduh?set=entahapa");
    expect(resSet.status).toBe(400);
    expect(resSet.body.error.code).toBe("SET_TIDAK_DIKENAL");
    expect(resSet.body.error.message).toContain("harian");

    const resFormat = await request(app).get(
      "/api/publik/unduh?set=harian&format=xlsx",
    );
    expect(resFormat.status).toBe(400);
    expect(resFormat.body.error.code).toBe("FORMAT_TIDAK_DIDUKUNG");
  });

  it("parameter berbentuk objek atau array tidak bocor ke pesan galat", async () => {
    // Express mem-parsing `?set[x]=y` menjadi objek. `String()` di atasnya
    // menghasilkan "[object Object]", yang lalu dipantulkan utuh ke peramban.
    const resObjek = await request(app).get("/api/publik/unduh?set[x]=y");
    expect(resObjek.status).toBe(200);
    expect(JSON.stringify(resObjek.body)).not.toContain("[object Object]");

    const resArray = await request(app).get(
      "/api/publik/unduh?format=csv&format=json&set=harian",
    );
    expect(resArray.status).toBe(200);
    expect(resArray.headers["content-type"]).toContain("text/csv");
  });
});
