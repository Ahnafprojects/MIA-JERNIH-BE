import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { lcdUtama } from "../src/rute/meter.js";

describe("Meter: telemetri, kontrol relay, dan akses (Issue #3)", () => {
  const app = buatApp();

  it("lcdUtama menghasilkan format yang sesuai spesifikasi firmware", () => {
    const lcd = lcdUtama({
      saldoL: 4820.5,
      saklarOn: true,
      debitLpm: 2.4,
      volumeTotalL: 8420.4,
    });

    expect(lcd.baris1).toBe("S=4820.50L  ON");
    expect(lcd.baris2).toBe("D=2.4   V=8420.4");
  });

  it("warga lain mengakses meter bukan miliknya membalas 403", async () => {
    const warga1 = await prisma.pengguna.create({
      data: {
        nama: "Warga Satu",
        email: `warga1_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const warga2 = await prisma.pengguna.create({
      data: {
        nama: "Warga Dua",
        email: `warga2_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga1.id,
        saldoL: 100,
        saklarOn: true,
      },
    });

    const tokenWarga2 = await buatAkses({ sub: warga2.id, peran: "WARGA" });

    const res = await request(app)
      .get(`/api/meter/${meterId}`)
      .set("Authorization", `Bearer ${tokenWarga2}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BUKAN_PEMILIK_METER");
  });

  it("relay tidak bisa aktif saat saldo 0 walau saklar ON", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Saldo Habis",
        email: `habis_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_ZERO_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 0,
        saklarOn: true,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const res = await request(app)
      .post(`/api/meter/${meterId}/relay`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        aksi: "buka",
        alasan: "Ingin membuka aliran air",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SALDO_HABIS");
  });

  it("perintah relay tercatat di AuditLog lengkap dengan alasan", async () => {
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Aktif",
        email: `aktif_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });

    const meterId = `MTR_AUDIT_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 500,
        saklarOn: true,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: "WARGA" });
    const alasanTutup = "Perbaikan kran bocor di kamar mandi";

    const res = await request(app)
      .post(`/api/meter/${meterId}/relay`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        aksi: "tutup",
        alasan: alasanTutup,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const log = await prisma.auditLog.findFirst({
      where: {
        aktorId: warga.id,
        aksi: "RELAY_TUTUP",
      },
      orderBy: { ts: "desc" },
    });

    expect(log).toBeDefined();
    expect(log?.detail).toContain(alasanTutup);
  });
});
