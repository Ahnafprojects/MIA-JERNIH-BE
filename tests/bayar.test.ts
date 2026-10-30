import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { selesaikanPembayaran } from "../src/rute/bayar.js";

describe("Pembayaran & Tagihan (Issue #5)", () => {
  const app = buatApp();

  it("mode auto-settle: LUNAS, kode 10 digit terbit, TIDAK menambah saldo meter", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Beli Air",
        email: `beli_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_BELI_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 50,
      },
    });

    const tokenJwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    // POST /api/pembayaran (default PAYMENT_AUTO_SETTLE=true di test)
    const res = await request(app)
      .post("/api/pembayaran")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({
        meterId,
        liter: 1000,
        metode: "QRIS",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("LUNAS");
    expect(res.body.kode).toMatch(/^\d{10}$/);
    expect(res.body.qrString).toBeNull();
    expect(res.body.vaNumber).toBeNull();

    // Pastikan Meter.saldoL TIDAK berubah karena pembelian
    const meterCek = await prisma.meter.findUnique({ where: { id: meterId } });
    expect(Number(meterCek?.saldoL)).toBe(50);

    // Pastikan token hasil pembelian bisa ditukarkan dan menambah saldo
    const resTukar = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${tokenJwt}`)
      .send({
        kode: res.body.kode,
        meterId,
      });

    expect(resTukar.status).toBe(200);
    expect(resTukar.body.status).toBe("BERHASIL");
    expect(resTukar.body.saldoBaruL).toBe(1050);

    const meterSetelahTukar = await prisma.meter.findUnique({ where: { id: meterId } });
    expect(Number(meterSetelahTukar?.saldoL)).toBe(1050);
  });

  it("webhook sukses dua kali hanya menerbitkan tepat satu token (idempoten)", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Webhook",
        email: `wh_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_WH_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 0,
      },
    });

    const invId = `INV-WH-${Date.now()}`;
    await prisma.transaksi.create({
      data: {
        id: invId,
        penggunaId: warga.id,
        meterId,
        jenis: "BELI",
        volumeL: 2000,
        jumlahRp: 15000,
        metode: "VA",
        status: "MENUNGGU",
      },
    });

    // Panggil fungsi pelunasan pertama
    const hasil1 = await selesaikanPembayaran(invId);
    expect(hasil1.transaksi.status).toBe("LUNAS");
    expect(hasil1.kodeToken).toBeDefined();

    // Panggil fungsi pelunasan kedua (idempoten)
    const hasil2 = await selesaikanPembayaran(invId);
    expect(hasil2.transaksi.status).toBe("LUNAS");
    expect(hasil2.kodeToken).toBeUndefined();

    // Pastikan hanya ada tepat 1 token yang terhubung ke transaksi ini
    const tokenCount = await prisma.token.count({
      where: { transaksiId: invId },
    });
    expect(tokenCount).toBe(1);
  });
});
