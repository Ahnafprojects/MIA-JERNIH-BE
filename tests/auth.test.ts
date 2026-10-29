import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashKode } from "../src/lib/auth.js";

describe("Autentikasi & Sesi (Issue #1)", () => {
  const app = buatApp();
  const emailTest = `warga_${Date.now()}@test.jernih.id`;
  const sandiTest = "PasswordAman123!";

  it("daftar -> verifikasi -> masuk -> refresh -> keluar", async () => {
    // 1. Daftar
    const resDaftar = await request(app)
      .post("/api/auth/daftar")
      .send({
        nama: "Warga Test",
        email: emailTest,
        hp: "081234567890",
        kataSandi: sandiTest,
      });

    expect(resDaftar.status).toBe(200);
    expect(resDaftar.body).toEqual({
      step: "VERIFIKASI_EMAIL",
      email: emailTest,
    });

    // Ambil kode dari database untuk verifikasi
    const kodeRecord = await prisma.kodeEmail.findFirst({
      where: { email: emailTest, tujuan: "daftar" },
      orderBy: { dibuatPada: "desc" },
    });
    expect(kodeRecord).toBeDefined();

    // 2. Verifikasi gagal dengan kode salah
    const resVerifSalah = await request(app)
      .post("/api/auth/verifikasi-email")
      .send({ email: emailTest, kode: "000000" });
    expect(resVerifSalah.status).toBe(400);
    expect(resVerifSalah.body.error.code).toBe("KODE_SALAH");

    // Cari kode plaintext atau timpa hash untuk tes
    const kodeUji = "123456";
    await prisma.kodeEmail.update({
      where: { id: kodeRecord!.id },
      data: { kodeHash: hashKode(kodeUji) },
    });

    // 3. Verifikasi sukses
    const resVerif = await request(app)
      .post("/api/auth/verifikasi-email")
      .send({ email: emailTest, kode: kodeUji });

    expect(resVerif.status).toBe(200);
    expect(resVerif.body).toHaveProperty("accessToken");
    expect(resVerif.body.pengguna.email).toBe(emailTest);

    // Cookie refresh harus terpasang
    const cookies = resVerif.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const cookieHeader = Array.isArray(cookies) ? cookies.join("; ") : cookies;
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).toContain("refresh=");
    const cookieKirim = cookieHeader ?? "";

    const accessToken = resVerif.body.accessToken;

    // 4. Buka /api/me dengan token akses
    const resMe = await request(app)
      .get("/api/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(resMe.status).toBe(200);
    expect(resMe.body.pengguna.email).toBe(emailTest);

    // 5. Masuk (Login)
    const resMasuk = await request(app)
      .post("/api/auth/masuk")
      .send({ email: emailTest, kataSandi: sandiTest });
    expect(resMasuk.status).toBe(200);
    expect(resMasuk.body).toHaveProperty("accessToken");

    // 6. Refresh token
    const resRefresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookieKirim);
    expect(resRefresh.status).toBe(200);
    expect(resRefresh.body).toHaveProperty("accessToken");

    // 7. Keluar
    const resKeluar = await request(app)
      .post("/api/auth/keluar")
      .set("Cookie", cookieKirim);
    expect(resKeluar.status).toBe(200);
    expect(resKeluar.body.ok).toBe(true);
  });

  it("kode kedaluwarsa ditolak; kode dipakai dua kali ditolak", async () => {
    const emailUnik = `test_kadaluwarsa_${Date.now()}@jernih.id`;
    const kodeUji = "888999";

    const user = await prisma.pengguna.create({
      data: {
        nama: "User Expired",
        email: emailUnik,
        kataSandiHash: "dummyhash123",
      },
    });

    // Kode kedaluwarsa
    const kodeExp = await prisma.kodeEmail.create({
      data: {
        penggunaId: user.id,
        email: emailUnik,
        kodeHash: hashKode(kodeUji),
        tujuan: "daftar",
        kedaluwarsaPada: new Date(Date.now() - 1000), // Sudah lewat
      },
    });

    const resExp = await request(app)
      .post("/api/auth/verifikasi-email")
      .send({ email: emailUnik, kode: kodeUji });
    expect(resExp.status).toBe(400);
    expect(resExp.body.error.code).toBe("KODE_KEDALUWARSA");

    // Kode sudah dipakai
    await prisma.kodeEmail.update({
      where: { id: kodeExp.id },
      data: {
        kedaluwarsaPada: new Date(Date.now() + 60000),
        dipakaiPada: new Date(),
      },
    });

    const resDipakai = await request(app)
      .post("/api/auth/verifikasi-email")
      .send({ email: emailUnik, kode: kodeUji });
    expect(resDipakai.status).toBe(400);
    expect(resDipakai.body.error.code).toBe("KODE_SUDAH_DIPAKAI");
  });

  it("refresh dipakai ulang -> seluruh sesi dicabut", async () => {
    const emailUnik = `test_reuse_${Date.now()}@jernih.id`;
    const user = await prisma.pengguna.create({
      data: {
        nama: "User Reuse",
        email: emailUnik,
        kataSandiHash: "dummyhash123",
        emailTerverifikasiPada: new Date(),
      },
    });

    // Buat sesi
    const tokenSesi = `token_reuse_${Date.now()}`;
    const refHash = hashKode(tokenSesi);
    const sesi = await prisma.sesi.create({
      data: {
        penggunaId: user.id,
        refreshHash: refHash,
        kedaluwarsaPada: new Date(Date.now() + 86400000),
        dicabutPada: new Date(), // sudah dicabut sebelumnya
      },
    });

    // Buat sesi kedua yang masih aktif
    const sesi2 = await prisma.sesi.create({
      data: {
        penggunaId: user.id,
        refreshHash: `hash_sesi_aktif_${Date.now()}`,
        kedaluwarsaPada: new Date(Date.now() + 86400000),
      },
    });

    // Panggil refresh dengan token yang sudah dicabut
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("x-refresh-token", tokenSesi);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESI_DICABUT");

    // Pastikan sesi2 ikut dicabut
    const cekSesi2 = await prisma.sesi.findUnique({ where: { id: sesi2.id } });
    expect(cekSesi2?.dicabutPada).not.toBeNull();
  });

  it("401 dari /auth/masuk membawa kode KREDENSIAL_SALAH", async () => {
    const res = await request(app)
      .post("/api/auth/masuk")
      .send({ email: "tidak-ada@jernih.id", kataSandi: "salah-sandi" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("KREDENSIAL_SALAH");
    expect(res.body.error.message).toBe("Email atau kata sandi salah.");
  });

  it("percobaan ke-21 dalam satu menit membalas 429", async () => {
    const calls = [];
    for (let i = 0; i < 21; i++) {
      calls.push(
        request(app)
          .post("/api/auth/masuk")
          .set("X-Forwarded-For", "192.168.100.50")
          .send({ email: "rate-limit@test.id", kataSandi: "wrong" }),
      );
    }
    const results = await Promise.all(calls);
    const has429 = results.some((r) => r.status === 429);
    expect(has429).toBe(true);
  });
});
