/**
 * Modul Realtime WebSocket.
 * Sesuai spesifikasi Issue #12.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { Peran } from "@prisma/client";
import { bacaAkses, type IsiAkses } from "./lib/auth.js";
import { prisma } from "./lib/prisma.js";
import { log } from "./lib/log.js";

export interface KlienWsMeta {
  penggunaId: string;
  peran: Peran;
  rooms: Set<string>;
}

export class JernihWebSocketManager {
  private wss: WebSocketServer;
  private klienMap = new Map<WebSocket, KlienWsMeta>();
  private roomMap = new Map<string, Set<WebSocket>>();
  private intervalTick: NodeJS.Timeout | null = null;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.setupTick();
  }

  public pasangKeServer(httpServer: HttpServer) {
    httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.tanganiUpgrade(req, socket, head).catch((err) => {
        log.error({ err }, "[WS] Gagal memproses upgrade");
        socket.destroy();
      });
    });

    httpServer.on("close", () => {
      this.tutup();
    });
  }

  private async tanganiUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "", `http://${host}`);

    if (url.pathname !== "/ws") {
      // Endpoint bukan /ws, lewati atau tolak
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let sesi: IsiAkses;
    try {
      sesi = await bacaAkses(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const roomParam = url.searchParams.get("rooms") ?? "";
    const requestedRooms = roomParam
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    // Filter kamar (room) sesuai hak akses
    const allowedRooms: string[] = [];
    for (const r of requestedRooms) {
      if (r.startsWith("meter:")) {
        const meterId = r.slice(6);
        if (sesi.peran === Peran.WARGA) {
          const m = await prisma.meter.findUnique({
            where: { id: meterId },
            select: { penggunaId: true },
          });
          if (m && m.penggunaId === sesi.sub) {
            allowedRooms.push(r);
          }
        } else {
          // Petugas boleh pantau meter mana pun
          allowedRooms.push(r);
        }
      } else if (r.startsWith("admin:")) {
        if (sesi.peran !== Peran.WARGA) {
          allowedRooms.push(r);
        }
      } else {
        allowedRooms.push(r);
      }
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.daftarkanKlien(ws, sesi.sub, sesi.peran, allowedRooms);
    });
  }

  private daftarkanKlien(
    ws: WebSocket,
    penggunaId: string,
    peran: Peran,
    rooms: string[],
  ) {
    const meta: KlienWsMeta = {
      penggunaId,
      peran,
      rooms: new Set(rooms),
    };

    this.klienMap.set(ws, meta);

    for (const r of rooms) {
      if (!this.roomMap.has(r)) {
        this.roomMap.set(r, new Set());
      }
      this.roomMap.get(r)!.add(ws);
    }

    // Kirim pesan salam (hello)
    ws.send(
      JSON.stringify({
        event: "hello",
        data: {
          penggunaId,
          peran,
          rooms,
        },
        ts: Date.now(),
      }),
    );

    ws.on("close", () => {
      this.lepasKlien(ws);
    });

    ws.on("error", () => {
      this.lepasKlien(ws);
    });
  }

  private lepasKlien(ws: WebSocket) {
    const meta = this.klienMap.get(ws);
    if (!meta) return;

    for (const r of meta.rooms) {
      const setWs = this.roomMap.get(r);
      if (setWs) {
        setWs.delete(ws);
        if (setWs.size === 0) {
          this.roomMap.delete(r);
        }
      }
    }

    this.klienMap.delete(ws);
  }

  public kirimKeRoom(room: string, event: string, data: unknown) {
    const setWs = this.roomMap.get(room);
    if (!setWs || setWs.size === 0) return;

    const pesan = JSON.stringify({ event, data, ts: Date.now() });
    for (const ws of setWs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(pesan);
      }
    }
  }

  private setupTick() {
    this.intervalTick = setInterval(() => {
      void (async () => {
        try {
          const dashboardClients = this.roomMap.get("admin:dashboard");
          if (dashboardClients && dashboardClients.size > 0) {
            const [totalPelanggan, totalMeter, meterOnline] = await Promise.all([
              prisma.pengguna.count({ where: { peran: Peran.WARGA } }),
              prisma.meter.count(),
              prisma.meter.count({ where: { daring: true } }),
            ]);

            this.kirimKeRoom("admin:dashboard", "dashboard", {
              kpi: [
                { key: "pelangganTerhubung", value: totalPelanggan },
                { key: "meterTotal", value: totalMeter },
                { key: "meterOnline", value: meterOnline },
              ],
            });
          }
        } catch (err) {
          log.error({ err }, "[WS] Galat pada interval tick dashboard");
        }
      })();
    }, 3000);
  }

  public tutup() {
    if (this.intervalTick) {
      clearInterval(this.intervalTick);
      this.intervalTick = null;
    }
    this.wss.close();
  }
}

export const wsManager = new JernihWebSocketManager();
