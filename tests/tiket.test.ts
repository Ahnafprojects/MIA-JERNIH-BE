import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { hitungSlaJatuhTempo } from "../src/rute/tiket.js";

describe("Pengaduan Tiket & Perhitungan SLA (Issue #6)", () => {
  const app = buatApp();

  it("nomor tiket unik berformat LP-YYYY-MM-NNNN dan SLA dihitung otomatis", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Pelapor Tiket 1",
        email: `tiket1_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const res = await request(app)
      .post("/api/tiket")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({
        kategori: "kebocoran pipa",
        deskripsi: "Pipa retak mengeluarkan air deras di jalan",
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.tiket.nomor).toMatch(/^LP-\d{4}-\d{2}-\d{4}$/);

    // Kategori kebocoran pipa memiliki batas SLA 6 jam
    const dibuat = new Date(res.body.tiket.dibuatPada);
    const tempo = new Date(res.body.tiket.slaJatuhTempo);
    const selisihJam = Math.round((tempo.getTime() - dibuat.getTime()) / (60 * 60 * 1000));
    expect(selisihJam).toBe(6);
  });

  it("slaTerlampaui akurat untuk kondisi tepat waktu vs telat", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Pelapor SLA",
        email: `sla_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    // 1. Tiket lewat tempo tapi belum selesai
    const tiketLewat = await prisma.tiket.create({
      data: {
        nomor: `LP-LEWAT-${Date.now()}`,
        pelaporId: warga.id,
        kategori: "air keruh/berbau",
        deskripsi: "Air keruh",
        slaJatuhTempo: new Date(Date.now() - 10000), // Sudah lewat
      },
    });

    const resDetailLewat = await request(app)
      .get(`/api/tiket/${tiketLewat.id}`)
      .set("Authorization", `Bearer ${tokenJwt}`);

    expect(resDetailLewat.status).toBe(200);
    expect(resDetailLewat.body.tiket.slaTerlampaui).toBe(true);

    // 2. Tiket selesai tepat waktu
    const tiketTepat = await prisma.tiket.create({
      data: {
        nomor: `LP-TEPAT-${Date.now()}`,
        pelaporId: warga.id,
        kategori: "air tidak mengalir",
        deskripsi: "Air mati total",
        status: "SELESAI",
        slaJatuhTempo: new Date(Date.now() + 12 * 60 * 60 * 1000),
        selesaiPada: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });

    const resDetailTepat = await request(app)
      .get(`/api/tiket/${tiketTepat.id}`)
      .set("Authorization", `Bearer ${tokenJwt}`);

    expect(resDetailTepat.status).toBe(200);
    expect(resDetailTepat.body.tiket.slaTerlampaui).toBe(false);
  });

  it("warga lain tidak bisa membaca tiket milik orang lain (403)", async () => {
    const wargaA = await prisma.pengguna.create({
      data: {
        nama: "Warga A",
        email: `wargaa_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const wargaB = await prisma.pengguna.create({
      data: {
        nama: "Warga B",
        email: `wargab_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const tiketA = await prisma.tiket.create({
      data: {
        nomor: `LP-PRIV-${Date.now()}`,
        pelaporId: wargaA.id,
        kategori: "tekanan lemah",
        deskripsi: "Tekanan air kecil",
        slaJatuhTempo: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const tokenB = await buatAkses({ sub: wargaB.id, peran: "WARGA" });

    const res = await request(app)
      .get(`/api/tiket/${tiketA.id}`)
      .set("Authorization", `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
  });

  it("perubahan status tiket oleh petugas tercatat dan menambah kronologi", async () => {
    const operator = await prisma.pengguna.create({
      data: {
        nama: "Petugas Operator",
        email: `op_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: "OPERATOR",
      },
    });

    const pelapor = await prisma.pengguna.create({
      data: {
        nama: "Warga Pelapor",
        email: `lapor_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const tiket = await prisma.tiket.create({
      data: {
        nomor: `LP-KRON-${Date.now()}`,
        pelaporId: pelapor.id,
        kategori: "kebocoran pipa",
        deskripsi: "Pipa bocor",
        status: "BARU",
        slaJatuhTempo: new Date(Date.now() + 6 * 60 * 60 * 1000),
      },
    });

    const tokenOp = await buatAkses({ sub: operator.id, peran: "OPERATOR" });

    // Update status ke DIPROSES
    const resPatch = await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({
        status: "DIPROSES",
        catatan: "Teknisi sedang meluncur ke lokasi",
      });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.ok).toBe(true);

    const tokenPelapor = await buatAkses({ sub: pelapor.id, peran: "WARGA" });
    const resDetail = await request(app)
      .get(`/api/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenPelapor}`);

    expect(resDetail.status).toBe(200);
    expect(resDetail.body.tiket.status).toBe("DIPROSES");
    expect(resDetail.body.tiket.kronologi.length).toBeGreaterThanOrEqual(2);
  });
});
