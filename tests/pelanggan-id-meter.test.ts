import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import argon2 from "argon2";

import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";

/**
 * `GET /api/admin/pelanggan/:id` harus menerima id METER, bukan hanya id
 * pengguna.
 *
 * ── Kenapa ini layak diuji ────────────────────────────────────────────
 *
 * `GET /api/admin/pelanggan` mengembalikan baris yang ber-`id` meter, sebab
 * satu baris di sana mewakili satu sambungan. Rute detailnya dulu hanya
 * mencari `Pengguna.id`, sehingga SETIAP pelanggan yang diklik di konsol
 * membalas 404 "Pelanggan tidak ditemukan" — seluruhnya, tanpa kecuali.
 *
 * Yang membuatnya mahal: gejalanya menunjuk ke arah yang salah. Ia terbaca
 * seperti seed yang gagal atau data yang kurang, padahal basis data berisi
 * 396 pelanggan lengkap dan yang keliru hanya bentuk id yang dioper.
 *
 * Uji ini mengunci kedua bentuk id, dan satu hal lagi yang gejalanya paling
 * halus: riwayat token harus ikut terbawa saat pelanggannya ditemukan lewat
 * id meter. Kalau kueri riwayat memakai id mentah, halamannya terbuka normal
 * tetapi riwayatnya kosong — dan petugas akan menyimpulkan pelanggan itu
 * tidak pernah membeli apa pun.
 */

const SUREL_OP = "op_pelanggan_id@contoh.test";
const SUREL_WARGA = "warga_pelanggan_id@contoh.test";
const SANDI = "uji-pelanggan-id-123";

let tokenOp = "";
let idPengguna = "";
let idMeter = "";

async function bersihkan(): Promise<void> {
  for (const surel of [SUREL_OP, SUREL_WARGA]) {
    const p = await prisma.pengguna.findUnique({ where: { email: surel } });
    if (!p) continue;
    await prisma.token.deleteMany({ where: { pemilikId: p.id } });
    await prisma.auditLog.deleteMany({ where: { aktorId: p.id } });
    await prisma.sesi.deleteMany({ where: { penggunaId: p.id } });
    await prisma.meter.deleteMany({ where: { penggunaId: p.id } });
    await prisma.pengguna.delete({ where: { id: p.id } });
  }
}

beforeAll(async () => {
  await bersihkan();
  const hash = await argon2.hash(SANDI, { type: argon2.argon2id });

  const op = await prisma.pengguna.create({
    data: {
      nama: "Operator Uji",
      email: SUREL_OP,
      kataSandiHash: hash,
      emailTerverifikasiPada: new Date(),
      peran: "OPERATOR",
      akunDemo: true,
    },
  });

  const warga = await prisma.pengguna.create({
    data: {
      nama: "Warga Uji Id",
      email: SUREL_WARGA,
      kataSandiHash: hash,
      emailTerverifikasiPada: new Date(),
      peran: "WARGA",
    },
  });
  idPengguna = warga.id;

  // `id` dan `node` wajib diisi sendiri: keduanya tanpa `@default` di skema.
  const unik = Math.floor(Math.random() * 1e9);
  const meter = await prisma.meter.create({
    data: {
      id: `PUJI${unik}`,
      node: `UJI.PID.${unik}`,
      serial: `JRN-UJI-${unik}`,
      penggunaId: warga.id,
      saldoL: 1234,
      lat: -7.28917,
      lng: 112.79583,
    },
  });
  idMeter = meter.id;

  // Satu token milik warga, untuk membuktikan riwayatnya ikut terbawa.
  /*
   * `kodeAwalan`, `nilaiL`, dan `kedaluwarsaPada` WAJIB diisi: ketiganya
   * tanpa `@default` di skema. Melewatkannya menghasilkan
   * PrismaClientValidationError yang hanya menyebut satu kolom pada satu
   * waktu, jadi lebih cepat membacanya dari skema daripada menebak.
   */
  await prisma.token.create({
    data: {
      kodeHash: `hash-uji-${unik}`,
      kodeAwalan: "4821",
      nilaiL: 1000,
      kedaluwarsaPada: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      meterId: meter.id,
      pemilikId: warga.id,
    },
  });

  /*
   * Token dibuat langsung, bukan lewat alur masuk, mengikuti pola
   * `tests/konsol.test.ts`. Yang diuji di sini resolusi id pelanggan, bukan
   * autentikasinya; melewatkan alur masuk juga menghindari verifikasi
   * perangkat baru yang tidak ada hubungannya dengan pokok uji ini.
   */
  tokenOp = await buatAkses({ sub: op.id, peran: "OPERATOR" });
});

afterAll(async () => {
  await bersihkan();
  await prisma.$disconnect();
});

describe("GET /api/admin/pelanggan/:id", () => {
  const app = buatApp();
  it("menerima id pengguna", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idPengguna}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    expect(res.body.detail.id).toBe(idPengguna);
  });

  it("menerima id METER dan membalas pemiliknya", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idMeter}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    // Yang dikembalikan tetap PENGGUNA-nya, bukan meternya.
    expect(res.body.detail.id).toBe(idPengguna);
    expect(res.body.detail.nama).toBe("Warga Uji Id");
  });

  it("membawa riwayat token saat ditemukan lewat id meter", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idMeter}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    /*
     * Inilah bagian yang gejalanya paling halus. Kalau kueri riwayat memakai
     * id dari parameter alih-alih id pengguna yang sudah diselesaikan,
     * larik ini kosong sementara halamannya terbuka normal.
     */
    expect(Array.isArray(res.body.riwayatToken)).toBe(true);
    expect(res.body.riwayatToken.length).toBeGreaterThan(0);
  });

  it("tetap 404 untuk id yang bukan pengguna maupun meter", async () => {
    const res = await request(app)
      .get("/api/admin/pelanggan/id-yang-tidak-ada-sama-sekali")
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(404);
  });
});

/**
 * Medan yang dibaca halaman detail tetapi tidak pernah dikirim.
 *
 * `pakaiHarian`, `adaInsiden`, serta `lat`/`lng` pada meter sudah lama dibaca
 * halaman `[id]/page.tsx`. Karena `useApi<T>` hanya MENGAKU bentuknya tanpa
 * memeriksanya saat jalan, ketiadaan medan itu tidak memunculkan galat apa
 * pun: nilainya `undefined`, lalu `.map()` pertama melempar dan seluruh
 * halaman tergantikan layar "This page couldn't load".
 *
 * Kompilasi, lint, dan build semuanya lolos selama cacat ini ada. Jadi
 * satu-satunya yang bisa menahannya kembali adalah uji yang memeriksa
 * bentuk jawabannya, bukan tipenya.
 */
describe("bentuk jawaban detail pelanggan", () => {
  const app = buatApp();

  it("mengirim seluruh medan yang dibaca halaman detail", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idMeter}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);

    for (const kunci of [
      "detail",
      "meter",
      "riwayatToken",
      "liniMasa",
      "adaInsiden",
      "pakaiHarian",
    ]) {
      expect(res.body, `medan \`${kunci}\` tidak dikirim`).toHaveProperty(
        kunci,
      );
    }

    expect(typeof res.body.adaInsiden).toBe("boolean");
    expect(Array.isArray(res.body.pakaiHarian.labels)).toBe(true);
    expect(Array.isArray(res.body.pakaiHarian.points)).toBe(true);
    // Satu label berpasangan dengan satu titik; grafik tidak boleh pincang.
    expect(res.body.pakaiHarian.points.length).toBe(
      res.body.pakaiHarian.labels.length,
    );
  });

  it("membawa koordinat meter untuk tautan ke peta jaringan", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idMeter}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    const m = res.body.meter[0];
    expect(m.lat).toBeCloseTo(-7.28917, 4);
    expect(m.lng).toBeCloseTo(112.79583, 4);
  });

  it("menandai meter tanpa insiden terbuka sebagai tidak berinsiden", async () => {
    const res = await request(app)
      .get(`/api/admin/pelanggan/${idPengguna}`)
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    expect(res.body.adaInsiden).toBe(false);
  });
});
