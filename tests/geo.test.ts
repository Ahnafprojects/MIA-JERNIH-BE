import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { Peran } from "@prisma/client";

describe("GeoJSON untuk Peta Konsol dan Peta Publik (Issue #10)", () => {
  const app = buatApp();

  it("admin peta: GeoJSON sah, legenda cocok dengan pin, dan meter tanpa koordinat tidak muncul sebagai pin", async () => {
    const op = await prisma.pengguna.create({
      data: {
        nama: "Operator Peta",
        email: `op_peta_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.OPERATOR,
      },
    });

    const tokenOp = await buatAkses({ sub: op.id, peran: Peran.OPERATOR });

    // Buat meter dengan koordinat [lng: 107.61, lat: -6.91]
    const meterAdaKoor = `MTR_KOOR_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterAdaKoor,
        node: `node_${meterAdaKoor}`,
        serial: `ser_${meterAdaKoor}`,
        lat: -6.9175,
        lng: 107.6191,
        daring: true,
        saldoL: 100,
        ambangPeringatanL: 5,
      },
    });

    // Buat meter TANPA koordinat
    const meterTanpaKoor = `MTR_NOKOOR_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterTanpaKoor,
        node: `node_${meterTanpaKoor}`,
        serial: `ser_${meterTanpaKoor}`,
        lat: null,
        lng: null,
      },
    });

    const res = await request(app)
      .get("/api/admin/peta")
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    expect(res.body.pin.type).toBe("FeatureCollection");
    expect(res.body.zona.type).toBe("FeatureCollection");
    expect(res.body).toHaveProperty("legenda");

    const { pin, legenda } = res.body;

    // Pastikan jumlah pin sama dengan total normal + warn + danger + offline di legenda
    const totalPinLegenda =
      legenda.normal + legenda.warn + legenda.danger + legenda.offline;
    expect(pin.features.length).toBe(totalPinLegenda);

    // Pastikan meter tanpa koordinat terhitung di tanpaKoordinat dan TIDAK ada di features
    expect(legenda.tanpaKoordinat).toBeGreaterThanOrEqual(1);
    const pinIds = pin.features.map(
      (f: { properties: { meterId: string } }) => f.properties.meterId,
    );
    expect(pinIds).not.toContain(meterTanpaKoor);
    expect(pinIds).toContain(meterAdaKoor);

    // Pastikan format koordinat GeoJSON adalah [lng, lat]
    const targetPin = pin.features.find(
      (f: { properties: { meterId: string } }) => f.properties.meterId === meterAdaKoor,
    );
    expect(targetPin.geometry.coordinates).toEqual([107.6191, -6.9175]);
  });

  it("peta publik tidak memuat koordinat meter individual", async () => {
    const res = await request(app).get("/api/publik/peta");
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("FeatureCollection");

    for (const f of res.body.features) {
      // Tidak boleh ada properti meterId atau rumah warga
      expect(f.properties).not.toHaveProperty("meterId");
      expect(f.properties).not.toHaveProperty("alamat");
      expect(f.properties).not.toHaveProperty("pelanggan");
    }
  });
});
