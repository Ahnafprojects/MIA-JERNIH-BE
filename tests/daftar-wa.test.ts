import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

/**
 * Nomor dari pendaftaran harus bisa langsung dipakai WhatsApp.
 *
 * ── Kenapa ini layak diuji ────────────────────────────────────────────
 *
 * Formulir pendaftaran meminta "Nomor Ponsel (WhatsApp / Telepon)", lalu
 * menyimpannya ke kolom `hp`. Pengirim WhatsApp tidak pernah membaca kolom
 * itu; ia membaca `waNomor` dan `waOptIn`. Jadi warga memberikan nomornya,
 * membaca kata "WhatsApp" pada labelnya, dan tetap tidak menerima apa pun.
 *
 * Yang membuatnya mahal: tidak ada galat sama sekali. Pendaftaran berhasil,
 * nomornya tersimpan, broadcast melaporkan ratusan penerima, dan yang
 * hilang hanya pesannya. Baru ketahuan saat seseorang menunggu pesan yang
 * tidak pernah datang.
 *
 * Uji ini mengunci dua arah sekaligus, dan arah KEDUA sama pentingnya:
 * tanpa persetujuan, nomor itu TIDAK boleh menyalakan WhatsApp.
 */

const SUREL = (n: string) => `daftar_wa_${n}@contoh.test`;
const SANDI = "uji-daftar-wa-123";

async function bersihkan(): Promise<void> {
  for (const n of ["setuju", "tolak", "ngawur"]) {
    const p = await prisma.pengguna.findUnique({ where: { email: SUREL(n) } });
    if (!p) continue;
    await prisma.kodeEmail.deleteMany({ where: { penggunaId: p.id } });
    await prisma.sesi.deleteMany({ where: { penggunaId: p.id } });
    await prisma.meter.deleteMany({ where: { penggunaId: p.id } });
    await prisma.pengguna.delete({ where: { id: p.id } });
  }
}

beforeAll(bersihkan);
afterAll(async () => {
  await bersihkan();
  await prisma.$disconnect();
});

describe("POST /api/auth/daftar — nomor WhatsApp dari pendaftaran", () => {
  const app = buatApp();

  it("menyalakan WhatsApp bila warga menyetujuinya", async () => {
    const res = await request(app).post("/api/auth/daftar").send({
      nama: "Uji Setuju",
      email: SUREL("setuju"),
      hp: "081333535732",
      kataSandi: SANDI,
      waSetuju: true,
    });
    expect(res.status).toBeLessThan(400);

    const p = await prisma.pengguna.findUnique({
      where: { email: SUREL("setuju") },
      select: { hp: true, waNomor: true, waOptIn: true },
    });
    expect(p?.waOptIn).toBe(true);
    // Disimpan dalam bentuk baku 62…, bukan apa adanya seperti diketik.
    expect(p?.waNomor).toBe("6281333535732");
    // `hp` tetap diisi: petugas memakainya untuk menghubungi warga.
    expect(p?.hp).toBe("081333535732");
  });

  it("TIDAK menyalakan WhatsApp tanpa persetujuan", async () => {
    const res = await request(app).post("/api/auth/daftar").send({
      nama: "Uji Tolak",
      email: SUREL("tolak"),
      hp: "081333535733",
      kataSandi: SANDI,
    });
    expect(res.status).toBeLessThan(400);

    const p = await prisma.pengguna.findUnique({
      where: { email: SUREL("tolak") },
      select: { hp: true, waNomor: true, waOptIn: true },
    });
    expect(p?.waOptIn).toBe(false);
    expect(p?.waNomor).toBeNull();
    expect(p?.hp).toBe("081333535733");
  });

  it("tidak menyalakan WhatsApp untuk nomor yang tidak sah", async () => {
    /*
     * Menyalakan `waOptIn` untuk nomor yang tidak bisa dikirimi membuat
     * halaman Akun menyatakan "WhatsApp aktif" padahal tidak ada pesan
     * yang akan pernah sampai.
     */
    const res = await request(app).post("/api/auth/daftar").send({
      nama: "Uji Ngawur",
      email: SUREL("ngawur"),
      hp: "12",
      kataSandi: SANDI,
      waSetuju: true,
    });
    expect(res.status).toBeLessThan(400);

    const p = await prisma.pengguna.findUnique({
      where: { email: SUREL("ngawur") },
      select: { waNomor: true, waOptIn: true },
    });
    expect(p?.waOptIn).toBe(false);
    expect(p?.waNomor).toBeNull();
  });
});
