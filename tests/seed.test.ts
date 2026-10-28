import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

describe("Seed Data Demo yang Masuk Akal (Issue #14)", () => {
  const app = buatApp();

  it("basis data memiliki seluruh data demo yang dipersyaratkan", async () => {
    const [zonaCount, golCount, penggunaCount, meterCount, tokenCount, insidenCount] =
      await Promise.all([
        prisma.zona.count(),
        prisma.golongan.count(),
        prisma.pengguna.count(),
        prisma.meter.count(),
        prisma.token.count(),
        prisma.insiden.count(),
      ]);

    expect(zonaCount).toBe(4);
    expect(golCount).toBe(4);
    expect(penggunaCount).toBeGreaterThanOrEqual(25);
    expect(meterCount).toBeGreaterThanOrEqual(20);
    expect(tokenCount).toBeGreaterThanOrEqual(40);
    expect(insidenCount).toBeGreaterThanOrEqual(3);
  });

  it("keempat status token (AKTIF, TERPAKAI, KEDALUWARSA, DIBATALKAN) terwakili", async () => {
    const statuses = await prisma.token.groupBy({
      by: ["status"],
      _count: true,
    });
    const statusSet = new Set(statuses.map((s) => s.status));

    expect(statusSet.has("AKTIF")).toBe(true);
    expect(statusSet.has("TERPAKAI")).toBe(true);
    expect(statusSet.has("KEDALUWARSA")).toBe(true);
    expect(statusSet.has("DIBATALKAN")).toBe(true);
  });

  it("ketepatan SLA di rapor kinerja publik berada di kisaran wajar (85-95%)", async () => {
    const res = await request(app).get("/api/publik/kinerja?rentang=30");
    expect(res.status).toBe(200);

    const slaKpi = res.body.kpi.find((k: { key: string }) => k.key === "ketepatanSlaPct");
    expect(slaKpi).toBeDefined();
    expect(slaKpi.value).toBeGreaterThanOrEqual(80);
    expect(slaKpi.value).toBeLessThanOrEqual(98);
  });

  it("peta status publik memperlihatkan minimal satu zona terganggu/perbaikan", async () => {
    const res = await request(app).get("/api/publik/status-layanan");
    expect(res.status).toBe(200);

    const ringkas = res.body.ringkas;
    const adaGangguan = ringkas.gangguan > 0 || ringkas.perbaikan > 0;
    expect(adaGangguan).toBe(true);
  });
});
