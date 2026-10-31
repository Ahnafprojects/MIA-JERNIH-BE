/**
 * Modul GeoJSON untuk peta konsol dan peta publik.
 * Sesuai spesifikasi Issue #10.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import pkg from "@prisma/client";
const { StatusInsiden } = pkg;
import { prisma } from "../lib/prisma.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";

export const geoRouter: Router = Router();

geoRouter.use(wajibMasuk);
geoRouter.use(wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"));

/** Kosakata status di GeoJSON. Konsol memakai nama lain; lihat `statusKonsol`. */
type StatusPin = "normal" | "warn" | "danger" | "offline";

/* ── 1. GET /api/admin/peta ──────────────────────────────────────────── */

geoRouter.get("/peta", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [semuaMeter, semuaZona] = await Promise.all([
      prisma.meter.findMany({
        include: {
          zona: { select: { id: true, nama: true } },
          insiden: {
            where: { status: { in: [StatusInsiden.BARU, StatusInsiden.DITUGASKAN] } },
          },
        },
      }),
      prisma.zona.findMany(),
    ]);

    let normalCount = 0;
    let warnCount = 0;
    let dangerCount = 0;
    let offlineCount = 0;
    let tanpaKoordinatCount = 0;

    const pinFeatures: Array<{
      type: "Feature";
      geometry: { type: "Point"; coordinates: [number, number] };
      properties: {
        meterId: string;
        serial: string;
        status: StatusPin;
        zonaId: string;
        zona: string | null;
        saldoL: number;
        debitLpm: number;
        relayOn: boolean;
      };
    }> = [];

    for (const m of semuaMeter) {
      // Meter tanpa koordinat jangan ditaruh di 0,0 (tengah samudra Atlantik)
      if (m.lat === null || m.lng === null) {
        tanpaKoordinatCount++;
        continue;
      }

      let status: StatusPin = "normal";

      if (m.insiden.length > 0) {
        status = "danger";
        dangerCount++;
      } else if (!m.daring) {
        status = "offline";
        offlineCount++;
      } else if (Number(m.saldoL) <= Number(m.ambangPeringatanL)) {
        status = "warn";
        warnCount++;
      } else {
        status = "normal";
        normalCount++;
      }

      pinFeatures.push({
        type: "Feature",
        geometry: {
          type: "Point",
          // Urutan koordinat GeoJSON: [lng, lat]
          coordinates: [m.lng, m.lat],
        },
        properties: {
          meterId: m.id,
          serial: m.serial,
          status,
          zonaId: m.zonaId ?? "",
          zona: m.zona?.nama ?? null,
          saldoL: Number(m.saldoL),
          debitLpm: Number(m.debitLpm),
          // Kolomnya enum StatusRelay, sedangkan konsol membacanya sebagai
          // boolean. Diterjemahkan di sini, bukan di klien, supaya hanya ada
          // satu tempat yang tahu nama enumnya.
          relayOn: m.relay === "AKTIF",
        },
      });
    }

    const zonaFeatures = semuaZona
      .filter((z) => z.batasGeo !== null)
      .map((z) => ({
        type: "Feature" as const,
        geometry: z.batasGeo as Record<string, unknown>,
        properties: {
          id: z.id,
          nama: z.nama,
        },
      }));

    /*
     * BENTUK DATAR — ini yang dibaca peta konsol.
     *
     * Endpoint ini sebelumnya hanya mengirim GeoJSON: `pin` berupa objek
     * `{ type, features }`. Halaman konsol membacanya sebagai SENARAI dan
     * langsung melakukan `for (const p of pin)`, sehingga melempar
     * "pin is not iterable" saat render. Lemparan itu terjadi di dalam
     * `useMemo`, jadi yang hilang bukan petanya saja melainkan SELURUH
     * halaman: batas galat Next menggantinya dengan "This page couldn't
     * load". Peta jaringan tidak bisa dibuka sama sekali.
     *
     * Kosakata statusnya juga berbeda. Di sini dulu `warn`/`danger`,
     * sedangkan konsol mengenal `alarm`/`insiden`. Nama status yang tidak
     * dikenal membuat pencarian gaya pin mengembalikan `undefined`, dan
     * pencarian berikutnya melempar lagi.
     *
     * GeoJSON tetap dikirim sebagai `pinGeo` dan `zonaGeo` supaya pemakai
     * lama tidak rusak.
     */
    const statusKonsol = (s: StatusPin): "normal" | "alarm" | "insiden" | "offline" =>
      s === "warn" ? "alarm" : s === "danger" ? "insiden" : s;

    const pin = pinFeatures.map((f) => ({
      id: f.properties.meterId,
      nama: f.properties.serial,
      zonaId: f.properties.zonaId,
      zona: f.properties.zona ?? "",
      koordinat: f.geometry.coordinates,
      status: statusKonsol(f.properties.status),
      saldoL: f.properties.saldoL,
      debitLpm: f.properties.debitLpm,
      relayOn: f.properties.relayOn,
    }));

    const perZona = new Map<string, { meter: number; alarm: number; offline: number }>();
    for (const p of pin) {
      if (!p.zonaId) continue;
      const isi = perZona.get(p.zonaId) ?? { meter: 0, alarm: 0, offline: 0 };
      isi.meter += 1;
      if (p.status === "alarm") isi.alarm += 1;
      if (p.status === "offline") isi.offline += 1;
      perZona.set(p.zonaId, isi);
    }

    res.status(200).json({
      pin,
      jumlahStatus: {
        normal: normalCount,
        alarm: warnCount,
        insiden: dangerCount,
        offline: offlineCount,
      },
      tanpaKoordinat: tanpaKoordinatCount,
      totalMeter: semuaMeter.length,
      zona: semuaZona.map((z) => ({
        id: z.id,
        nama: z.nama,
        meter: perZona.get(z.id)?.meter ?? 0,
        alarm: perZona.get(z.id)?.alarm ?? 0,
        offline: perZona.get(z.id)?.offline ?? 0,
      })),
      pinGeo: {
        type: "FeatureCollection",
        features: pinFeatures,
      },
      zonaGeo: {
        type: "FeatureCollection",
        features: zonaFeatures,
      },
      legenda: {
        normal: normalCount,
        warn: warnCount,
        danger: dangerCount,
        offline: offlineCount,
        tanpaKoordinat: tanpaKoordinatCount,
      },
    });
  } catch (err) {
    next(err);
  }
});
