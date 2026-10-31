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

    /*
     * `pin` adalah SENARAI, bukan FeatureCollection.
     *
     * Konsol membacanya dengan `for (const p of pin)`. Saat endpoint ini
     * masih mengirim GeoJSON di kunci `pin`, perulangan itu melempar
     * "pin is not iterable" di dalam `useMemo`, dan batas galat Next
     * mengganti SELURUH halaman peta dengan "This page couldn't load".
     */
    expect(Array.isArray(res.body.pin)).toBe(true);
    expect(Array.isArray(res.body.zona)).toBe(true);
    expect(res.body).toHaveProperty("jumlahStatus");
    expect(res.body).toHaveProperty("tanpaKoordinat");

    // GeoJSON tetap tersedia di kunci terpisah untuk pemakai lama.
    expect(res.body.pinGeo.type).toBe("FeatureCollection");
    expect(res.body.zonaGeo.type).toBe("FeatureCollection");
    expect(res.body).toHaveProperty("legenda");

    const { pin, legenda, jumlahStatus } = res.body;

    // Jumlah pin harus sama dengan total seluruh status di legenda.
    const totalPinLegenda =
      legenda.normal + legenda.warn + legenda.danger + legenda.offline;
    expect(pin.length).toBe(totalPinLegenda);

    /*
     * Kosakata status konsol: normal, alarm, insiden, offline. Nama di luar
     * daftar itu membuat pencarian gaya pin mengembalikan `undefined`, dan
     * pencarian berikutnya melempar saat render.
     */
    const sah = ["normal", "alarm", "insiden", "offline"];
    for (const p of pin) expect(sah).toContain(p.status);
    expect(Object.keys(jumlahStatus).sort()).toEqual([...sah].sort());

    // Meter tanpa koordinat dihitung terpisah dan tidak muncul sebagai pin.
    expect(legenda.tanpaKoordinat).toBeGreaterThanOrEqual(1);
    const pinIds = pin.map((p: { id: string }) => p.id);
    expect(pinIds).not.toContain(meterTanpaKoor);
    expect(pinIds).toContain(meterAdaKoor);

    // Urutan koordinat tetap [lng, lat], sama dengan GeoJSON.
    const target = pin.find((p: { id: string }) => p.id === meterAdaKoor);
    expect(target.koordinat).toEqual([107.6191, -6.9175]);
    expect(typeof target.relayOn).toBe("boolean");
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
