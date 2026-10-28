import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses, hashKode } from "../src/lib/auth.js";
import { StatusToken } from "@prisma/client";

describe("Token: aturan, generator, dan penukaran (Issue #4)", () => {
  const app = buatApp();

  it("format 4-10 digit; huruf atau format tidak valid ditolak", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Token Format",
        email: `token_fmt_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_FMT_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: "WARGA" });

    // Huruf
    const resHuruf = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${token}`)
      .send({ kode: "ABCD1234", meterId });
    expect(resHuruf.status).toBe(400);

    // Terlalu pendek (< 4)
    const resPendek = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${token}`)
      .send({ kode: "123", meterId });
    expect(resPendek.status).toBe(400);
  });

  it("demo 1111 (+5 L) dan 2222 (+10 L) selalu diterima dan tidak memakai kuota gagal", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Demo Token",
        email: `token_demo_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_DEMO_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 20,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const res1111 = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${token}`)
      .send({ kode: "1111", meterId });

    expect(res1111.status).toBe(200);
    expect(res1111.body.status).toBe("BERHASIL");
    expect(res1111.body.nilaiL).toBe(5);
    expect(res1111.body.saldoBaruL).toBe(25);

    const res2222 = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${token}`)
      .send({ kode: "2222", meterId });

    expect(res2222.status).toBe(200);
    expect(res2222.body.nilaiL).toBe(10);
    expect(res2222.body.saldoBaruL).toBe(35);
  });

  it("penukaran kedua ditolak dengan tanggal pemakaian", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Token Pakai",
        email: `token_pk_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_PK_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 0,
      },
    });

    const kode = `98765${Date.now().toString().slice(-5)}`;
    const tokenRecord = await prisma.token.create({
      data: {
        kodeHash: hashKode(kode),
        kodeAwalan: kode.slice(0, 5),
        nilaiL: 1000,
        status: StatusToken.AKTIF,
        meterId,
        pemilikId: warga.id,
        kedaluwarsaPada: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    // Tukar pertama: sukses
    const res1 = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({ kode, meterId });
    expect(res1.status).toBe(200);
    expect(res1.body.saldoBaruL).toBe(1000);

    // Tukar kedua: ditolak dan menyebut tanggal pemakaian
    const res2 = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({ kode, meterId });
    expect(res2.status).toBe(400);
    expect(res2.body.error.code).toBe("TOKEN_SUDAH_DIPAKAI");
    expect(res2.body.error.message).toContain("Token sudah dipakai pada");
  });

  it("token meter A ditolak di meter B", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Dua Meter",
        email: `token_m2_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterA = `MTR_A_${Date.now()}`;
    const meterB = `MTR_B_${Date.now()}`;

    await prisma.meter.createMany({
      data: [
        { id: meterA, node: `node_${meterA}`, serial: `ser_${meterA}`, penggunaId: warga.id },
        { id: meterB, node: `node_${meterB}`, serial: `ser_${meterB}`, penggunaId: warga.id },
      ],
    });

    const kode = `54321${Date.now().toString().slice(-5)}`;
    await prisma.token.create({
      data: {
        kodeHash: hashKode(kode),
        kodeAwalan: "54321",
        nilaiL: 500,
        meterId: meterA, // terikat meter A
        kedaluwarsaPada: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const res = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({ kode, meterId: meterB });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("METER_TIDAK_COCOK");
  });

  it("token lewat 30 hari ditolak", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Token Exp",
        email: `token_exp_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_EXP_${Date.now()}`;
    await prisma.meter.create({
      data: { id: meterId, node: `node_${meterId}`, serial: `ser_${meterId}`, penggunaId: warga.id },
    });

    const kode = `12345${Date.now().toString().slice(-5)}`;
    await prisma.token.create({
      data: {
        kodeHash: hashKode(kode),
        kodeAwalan: "12345",
        nilaiL: 500,
        meterId,
        kedaluwarsaPada: new Date(Date.now() - 1000), // Lewat 30 hari
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const res = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({ kode, meterId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_KEDALUWARSA");
  });

  it("5 kali salah berturut-turut -> percobaan keenam dijeda per pengguna", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Salah Token",
        email: `token_brute_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_BRUTE_${Date.now()}`;
    await prisma.meter.create({
      data: { id: meterId, node: `node_${meterId}`, serial: `ser_${meterId}`, penggunaId: warga.id },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/token/tukar")
        .set("Authorization", `Bearer ${tokenJwt}`)
        .send({ kode: `9999000${i}`, meterId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("TOKEN_INVALID");
    }

    // Percobaan ke-6 dijeda (lockout)
    const resKeenam = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({ kode: "9999999999", meterId });

    expect(resKeenam.status).toBe(400);
    expect(resKeenam.body.error.code).toBe("PERCOBAAN_TERKUNCI");
  });
});
