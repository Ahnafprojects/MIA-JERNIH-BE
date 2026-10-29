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
        status: "normal" | "warn" | "danger" | "offline";
        zona: string | null;
        saldoL: number;
      };
    }> = [];

    for (const m of semuaMeter) {
      // Meter tanpa koordinat jangan ditaruh di 0,0 (tengah samudra Atlantik)
      if (m.lat === null || m.lng === null) {
        tanpaKoordinatCount++;
        continue;
      }

      let status: "normal" | "warn" | "danger" | "offline" = "normal";

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
          zona: m.zona?.nama ?? null,
          saldoL: Number(m.saldoL),
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

    res.status(200).json({
      pin: {
        type: "FeatureCollection",
        features: pinFeatures,
      },
      zona: {
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
