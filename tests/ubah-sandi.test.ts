/**
 * `PUT /api/me/kata-sandi` — mengganti kata sandi dari dalam akun.
 *
 * Yang diuji di sini adalah aturan KEAMANANNYA, bukan bentuk jawabannya.
 * Endpoint ini satu-satunya jalan mengubah kredensial tanpa akses ke kotak
 * surat, jadi tiap lubang di sini berarti sesi yang ditinggalkan terbuka
 * bisa diubah menjadi pengambilalihan akun permanen.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashSandi, hashRefresh, buatRefresh } from "../src/lib/auth.js";

const app = buatApp();

const SANDI_AWAL = "SandiLamaAman123";
const SANDI_BARU = "SandiBaruAman456";

const email = `ubahsandi_${Date.now()}@test.jernih.id`;

let penggunaId = "";

/** Masuk dan kembalikan access token + cookie refresh-nya. */
async function masuk(sandi: string) {
  const res = await request(app)
    .post("/api/auth/masuk")
    .send({ email, kataSandi: sandi });
  return res;
}

beforeAll(async () => {
  /*
   * Akun dibuat langsung lewat Prisma, bukan lewat alur daftar + verifikasi.
   * Alur itu sudah punya tesnya sendiri di `auth.test.ts`; mengulanginya di
   * sini hanya menambah cara baru bagi berkas ini untuk gagal karena sebab
   * yang tidak ada hubungannya dengan kata sandi.
   *
   * `akunDemo: true` melewati verifikasi perangkat baru — tanpa itu, `masuk`
   * membalas `step: "KODE_EMAIL"` untuk kode yang tidak akan pernah sampai,
   * dan seluruh berkas tes ini berhenti di langkah pertama.
   */
  const pengguna = await prisma.pengguna.create({
    data: {
      nama: "Warga Ubah Sandi",
      email,
      kataSandiHash: await hashSandi(SANDI_AWAL),
      emailTerverifikasiPada: new Date(),
      akunDemo: true,
    },
  });
  penggunaId = pengguna.id;
});

describe("penolakan", () => {
  it("tanpa masuk ditolak 401", async () => {
    const res = await request(app)
      .put("/api/me/kata-sandi")
      .send({ kataSandiLama: SANDI_AWAL, kataSandiBaru: SANDI_BARU });

    expect(res.status).toBe(401);
  });

  it("INTI: kata sandi lama yang salah ditolak, dan sandi TIDAK berubah", async () => {
    const sesi = await masuk(SANDI_AWAL);
    expect(sesi.status).toBe(200);

    const res = await request(app)
      .put("/api/me/kata-sandi")
      .set("Authorization", `Bearer ${sesi.body.accessToken}`)
      .send({ kataSandiLama: "TebakanSalah999", kataSandiBaru: SANDI_BARU });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SANDI_LAMA_SALAH");

    // Yang menentukan bukan kode galatnya, melainkan bahwa sandi aslinya
    // masih berlaku sesudahnya.
    const masihBisa = await masuk(SANDI_AWAL);
    expect(masihBisa.status).toBe(200);
  });

  it("kata sandi baru di bawah 8 karakter ditolak", async () => {
    const sesi = await masuk(SANDI_AWAL);

    const res = await request(app)
      .put("/api/me/kata-sandi")
      .set("Authorization", `Bearer ${sesi.body.accessToken}`)
      .send({ kataSandiLama: SANDI_AWAL, kataSandiBaru: "pendek7" });

    expect(res.status).toBe(400);

    const masihBisa = await masuk(SANDI_AWAL);
    expect(masihBisa.status).toBe(200);
  });

  it("kata sandi baru yang sama dengan yang lama ditolak", async () => {
    const sesi = await masuk(SANDI_AWAL);

    const res = await request(app)
      .put("/api/me/kata-sandi")
      .set("Authorization", `Bearer ${sesi.body.accessToken}`)
      .send({ kataSandiLama: SANDI_AWAL, kataSandiBaru: SANDI_AWAL });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SANDI_SAMA");
  });
});

describe("penggantian yang berhasil", () => {
  it("INTI: sandi benar -> sandi baru dipakai, sandi lama DITOLAK", async () => {
    const sesi = await masuk(SANDI_AWAL);
    expect(sesi.status).toBe(200);

    const res = await request(app)
      .put("/api/me/kata-sandi")
      .set("Authorization", `Bearer ${sesi.body.accessToken}`)
      .send({ kataSandiLama: SANDI_AWAL, kataSandiBaru: SANDI_BARU });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const denganBaru = await masuk(SANDI_BARU);
    expect(denganBaru.status).toBe(200);
    expect(denganBaru.body).toHaveProperty("accessToken");

    const denganLama = await masuk(SANDI_AWAL);
    expect(denganLama.status).toBe(401);
    expect(denganLama.body.error.code).toBe("KREDENSIAL_SALAH");

    // Dikembalikan supaya uji sesi di bawah berangkat dari keadaan yang sama.
    await prisma.pengguna.update({
      where: { id: penggunaId },
      data: { kataSandiHash: await hashSandi(SANDI_AWAL) },
    });
  });

  it("sesi LAIN dicabut, sesi yang sedang dipakai tetap hidup", async () => {
    /*
     * Dua sesi palsu ditanam langsung: satu mewakili peramban lain milik
     * pemilik akun (atau penyusup), satu lagi menjadi sesi "sekarang" yang
     * cookie-nya ikut dikirim bersama permintaan.
     */
    const tokenSekarang = buatRefresh();
    const tokenLain = buatRefresh();
    const esok = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const sesiSekarang = await prisma.sesi.create({
      data: {
        penggunaId,
        refreshHash: hashRefresh(tokenSekarang),
        perangkat: "peramban-sekarang",
        ip: "127.0.0.1",
        kedaluwarsaPada: esok,
      },
    });

    const sesiLain = await prisma.sesi.create({
      data: {
        penggunaId,
        refreshHash: hashRefresh(tokenLain),
        perangkat: "peramban-lain",
        ip: "10.0.0.9",
        kedaluwarsaPada: esok,
      },
    });

    const masukRes = await masuk(SANDI_AWAL);

    const res = await request(app)
      .put("/api/me/kata-sandi")
      .set("Authorization", `Bearer ${masukRes.body.accessToken}`)
      .set("Cookie", [`refresh=${tokenSekarang}`])
      .send({ kataSandiLama: SANDI_AWAL, kataSandiBaru: SANDI_BARU });

    expect(res.status).toBe(200);

    const sesudahSekarang = await prisma.sesi.findUnique({
      where: { id: sesiSekarang.id },
    });
    const sesudahLain = await prisma.sesi.findUnique({
      where: { id: sesiLain.id },
    });

    expect(sesudahSekarang?.dicabutPada).toBeNull();
    expect(sesudahLain?.dicabutPada).not.toBeNull();

    await prisma.pengguna.update({
      where: { id: penggunaId },
      data: { kataSandiHash: await hashSandi(SANDI_AWAL) },
    });
  });
});
