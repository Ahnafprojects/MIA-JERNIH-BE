import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

describe("Endpoint Publik — Transparansi (Issue #2)", () => {
  const app = buatApp();

  it("5 endpoint publik dapat diakses tanpa token", async () => {
    const resStatus = await request(app).get("/api/publik/status-layanan");
    expect(resStatus.status).toBe(200);
    expect(resStatus.body).toHaveProperty("zona");
    expect(resStatus.body).toHaveProperty("ringkas");

    const resKinerja = await request(app).get("/api/publik/kinerja");
    expect(resKinerja.status).toBe(200);
    expect(resKinerja.body).toHaveProperty("kpi");
    expect(Array.isArray(resKinerja.body.kpi)).toBe(true);

    const resStatistik = await request(app).get("/api/publik/statistik");
    expect(resStatistik.status).toBe(200);
    expect(resStatistik.body).toHaveProperty("agregat");

    const resPeta = await request(app).get("/api/publik/peta");
    expect(resPeta.status).toBe(200);
    expect(resPeta.body.type).toBe("FeatureCollection");
  });

  it("lacak tiket: aman tanpa data pribadi dan membalas 404 ramah bila nomor tidak ada", async () => {
    // 404 untuk nomor tidak dikenal
    const res404 = await request(app).get("/api/publik/lacak/LP-9999-99-9999");
    expect(res404.status).toBe(404);
    expect(res404.body.error.message).toContain("tidak ditemukan");

    // Buat data tiket riil
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Rahasia",
        email: `rahasia_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        alamat: "Jl. Data Pribadi No. 99",
        hp: "0899999999",
      },
    });

    const nomorTiket = `LP-2026-10-${Date.now().toString().slice(-4)}`;
    const tiket = await prisma.tiket.create({
      data: {
        nomor: nomorTiket,
        pelaporId: warga.id,
        kategori: "Kebocoran pipa",
        deskripsi: "Pipa bocor di depan rumah",
        status: "DIPROSES",
        slaJatuhTempo: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const resLacak = await request(app).get(`/api/publik/lacak/${tiket.nomor}`);
    expect(resLacak.status).toBe(200);
    expect(resLacak.body.nomor).toBe(nomorTiket);
    expect(resLacak.body.kategori).toBe("Kebocoran pipa");
    expect(resLacak.body.status).toBe("DIPROSES");

    // PASTIKAN TIDAK ADA DATA PRIBADI
    expect(resLacak.body).not.toHaveProperty("nama");
    expect(resLacak.body).not.toHaveProperty("alamat");
    expect(resLacak.body).not.toHaveProperty("email");
    expect(resLacak.body).not.toHaveProperty("hp");
    expect(resLacak.body).not.toHaveProperty("pelaporId");
    expect(resLacak.body).not.toHaveProperty("meterId");
    expect(resLacak.body).toHaveProperty("kronologi");
    expect(resLacak.body.kronologi.length).toBeGreaterThanOrEqual(2);
  });

  it("kpi berbentuk array dan bisa dicari lewat key", async () => {
    const res = await request(app).get("/api/publik/kinerja");
    expect(res.status).toBe(200);
    const kpi = res.body.kpi;
    expect(Array.isArray(kpi)).toBe(true);

    const tiketMasukKpi = kpi.find((k: { key: string }) => k.key === "tiketMasuk");
    expect(tiketMasukKpi).toBeDefined();
    expect(typeof tiketMasukKpi.value).toBe("number");
  });
});
