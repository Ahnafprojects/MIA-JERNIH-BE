import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { JernihWebSocketManager } from "../src/ws.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { Peran } from "@prisma/client";

describe("Realtime WebSocket (Issue #12)", () => {
  it("GET /ws permintaan HTTP biasa tanpa upgrade membalas 404", async () => {
    const app = buatApp();
    const res = await request(app).get("/ws");
    expect(res.status).toBe(404);
  });

  it("handshake tanpa token ditolak (401), dengan token menerima hello", async () => {
    const app = buatApp();
    const server = createServer(app);
    const wsManager = new JernihWebSocketManager();
    wsManager.pasangKeServer(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    const port = address.port;

    // 1. Tanpa token -> ditolak (401)
    await expect(
      new Promise((_, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("error", (err) => reject(err));
      }),
    ).rejects.toThrow();

    // 2. Dengan token sah -> menerima event hello
    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga WS",
        email: `ws_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: Peran.WARGA,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: Peran.WARGA });

    const pesanHello = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      ws.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        resolve(parsed);
        ws.close();
      });
      ws.on("error", (err) => reject(err));
    });

    expect(pesanHello.event).toBe("hello");
    expect(pesanHello.data.penggunaId).toBe(warga.id);
    expect(pesanHello.data.peran).toBe("WARGA");

    wsManager.tutup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("warga tidak bisa join room meter orang lain", async () => {
    const app = buatApp();
    const server = createServer(app);
    const wsManager = new JernihWebSocketManager();
    wsManager.pasangKeServer(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    const port = address.port;

    const warga1 = await prisma.pengguna.create({
      data: {
        nama: "Warga WS 1",
        email: `ws1_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: Peran.WARGA,
      },
    });

    const warga2 = await prisma.pengguna.create({
      data: {
        nama: "Warga WS 2",
        email: `ws2_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: Peran.WARGA,
      },
    });

    const meterId2 = `MTR_WS2_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId2,
        node: `node_${meterId2}`,
        serial: `ser_${meterId2}`,
        penggunaId: warga2.id,
      },
    });

    const token1 = await buatAkses({ sub: warga1.id, peran: Peran.WARGA });

    // Warga 1 mencoba join meter milik Warga 2 dan admin:dashboard
    const pesanHello = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?token=${token1}&rooms=meter:${meterId2},admin:dashboard`,
      );
      ws.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        resolve(parsed);
        ws.close();
      });
      ws.on("error", (err) => reject(err));
    });

    // Server harus menyaring room yang tidak berhak
    expect(pesanHello.data.rooms).not.toContain(`meter:${meterId2}`);
    expect(pesanHello.data.rooms).not.toContain("admin:dashboard");

    wsManager.tutup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("siaran kirimKeRoom sampai ke pelanggan yang join room meter miliknya", async () => {
    const app = buatApp();
    const server = createServer(app);
    const wsManager = new JernihWebSocketManager();
    wsManager.pasangKeServer(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    const port = address.port;

    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga WS Broadcast",
        email: `ws_bc_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: Peran.WARGA,
      },
    });

    const meterId = `MTR_WS_BC_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
      },
    });

    const token = await buatAkses({ sub: warga.id, peran: Peran.WARGA });

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${token}&rooms=meter:${meterId}`,
    );

    const receivedEvents: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        receivedEvents.push(parsed);
        if (parsed.event === "hello") {
          wsManager.kirimKeRoom(`meter:${meterId}`, "meter:relay", {
            meterId,
            relay: "AKTIF",
          });
        } else if (parsed.event === "meter:relay") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", (err) => reject(err));
    });

    expect(receivedEvents.some((e) => e.event === "meter:relay")).toBe(true);
    const relayEvent = receivedEvents.find((e) => e.event === "meter:relay");
    expect(relayEvent.data.relay).toBe("AKTIF");

    wsManager.tutup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
