import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { jalankanDeteksiInsidenOtomatis } from "../src/rute/insiden.js";
import { StatusRelay } from "@prisma/client";

describe("Insiden & Alarm: deteksi otomatis (Issue #7)", () => {
  const app = buatApp();

  it("deteksi otomatis membuat insiden baru dan menduplikasi tanpa membuat baris baru", async () => {
    const meterId = `MTR_INS_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        saldoL: 0,
        relay: StatusRelay.NONAKTIF,
      },
    });

    // Jalankan deteksi otomatis pertama
    const hasil1 = await jalankanDeteksiInsidenOtomatis();
    expect(hasil1.baru).toBeGreaterThanOrEqual(1);

    const hitungAwal = await prisma.insiden.count({
      where: { meterId, tipe: "saldo habis" },
    });
    expect(hitungAwal).toBe(1);

    // Jalankan deteksi otomatis kedua: harus update (deduplikasi), bukan tambah row
    const hasil2 = await jalankanDeteksiInsidenOtomatis();
    expect(hasil2.diperbarui).toBeGreaterThanOrEqual(1);

    const hitungKedua = await prisma.insiden.count({
      where: { meterId, tipe: "saldo habis" },
    });
    expect(hitungKedua).toBe(1);
  });

  it("sensor offline tidak dipicu oleh meter yang belum terpasang/tidak daring", async () => {
    const meterOfflineNonDaring = `MTR_OFF_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterOfflineNonDaring,
        node: `node_${meterOfflineNonDaring}`,
        serial: `ser_${meterOfflineNonDaring}`,
        daring: false, // Tidak daring / belum terpasang
        terakhirTerlihat: new Date(Date.now() - 3600 * 1000), // 1 jam lalu
        saldoL: 100,
        relay: StatusRelay.AKTIF,
      },
    });

    await jalankanDeteksiInsidenOtomatis();

    const insiden = await prisma.insiden.findFirst({
      where: {
        meterId: meterOfflineNonDaring,
        tipe: "sensor offline",
      },
    });

    expect(insiden).toBeNull();
  });

  it("petugas dapat melihat daftar insiden dan memperbarui statusnya", async () => {
    const operator = await prisma.pengguna.create({
      data: {
        nama: "Operator Insiden",
        email: `op_ins_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: "OPERATOR",
      },
    });

    const tokenOp = await buatAkses({ sub: operator.id, peran: "OPERATOR" });

    const insiden = await prisma.insiden.create({
      data: {
        tipe: "kebocoran",
        judul: "Pipa Distribusi Bocor",
        detail: "Debit konstan di malam hari",
        status: "BARU",
      },
    });

    const resList = await request(app)
      .get("/api/admin/insiden")
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(resList.status).toBe(200);
    expect(resList.body.insiden.length).toBeGreaterThanOrEqual(1);

    const resPatch = await request(app)
      .patch(`/api/admin/insiden/${insiden.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({
        status: "DITUGASKAN",
        detail: "Tim teknisi diberangkatkan",
      });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.insiden.status).toBe("DITUGASKAN");
  });
});
