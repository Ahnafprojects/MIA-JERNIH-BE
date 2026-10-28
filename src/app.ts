/**
 * Perakitan aplikasi Express.
 *
 * Dipisah dari `server.ts` supaya tes bisa memakai `buatApp()` lewat
 * supertest tanpa benar-benar membuka port.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { env } from "./env.js";
import { AppError } from "./lib/errors.js";
import { log } from "./lib/log.js";
import { authRouter, meRouter } from "./rute/auth.js";
import { publikRouter } from "./rute/publik.js";
import { meterRouter } from "./rute/meter.js";
import { tokenRouter, adminTokenRouter } from "./rute/token.js";
import { bayarRouter } from "./rute/bayar.js";
import { tiketRouter } from "./rute/tiket.js";
import { insidenRouter } from "./rute/insiden.js";
import { konsolRouter } from "./rute/konsol.js";
import { geoRouter } from "./rute/geo.js";
import { notifikasiRouter } from "./rute/notifikasi.js";

export function buatApp(): Express {
  const app = express();
  const cfg = env();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: cfg.CORS_ORIGIN.split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  /*
   * Batas global longgar; endpoint sensitif (masuk, token) memasang batasnya
   * sendiri. Jangan diketatkan di sini: plugin menghitung SETIAP permintaan,
   * bukan hanya yang gagal, jadi satu kantor di balik satu NAT akan terkunci
   * padahal tidak melakukan apa pun yang salah.
   */
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: {
            code: "RATE_LIMIT",
            message: "Terlalu banyak permintaan. Coba lagi beberapa saat.",
          },
        }),
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "jernih-api", ts: new Date().toISOString() });
  });

  /*
   * Urutannya penting: `/api/publik` didaftarkan SEBELUM router lain yang
   * memasang penjaga sesi, supaya halaman transparansi tidak pernah ikut
   * terkunci. Pernah terjadi di versi sebelumnya — seluruh aplikasi di balik
   * login, dan yang dilihat juri cuma formulir masuk.
   */
  app.use("/api/publik", publikRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/meter", meterRouter);
  app.use("/api/token", tokenRouter);
  app.use("/api/bayar", bayarRouter);
  app.use("/api/tiket", tiketRouter);
  app.use("/api/insiden", insidenRouter);
  app.use("/api/notifikasi", notifikasiRouter);
  app.use("/api/admin/token", adminTokenRouter);
  app.use("/api/admin", konsolRouter);
  app.use("/api/admin", geoRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan." },
    });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, ...err.extra },
      });
      return;
    }

    if (err instanceof ZodError) {
      // Pesan per-field, bukan satu kalimat umum: pengguna perlu tahu KOLOM
      // mana yang salah, bukan sekadar "data tidak valid".
      const issues = err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      res.status(400).json({
        error: {
          code: "VALIDASI_GAGAL",
          message: issues[0]?.message ?? "Data yang dikirim tidak valid.",
          field: issues[0]?.field,
          issues,
        },
      });
      return;
    }

    log.error({ err, jalur: req.originalUrl }, "galat tak tertangani");
    res.status(500).json({
      error: {
        code: "INTERNAL",
        message: "Terjadi gangguan di server. Coba lagi beberapa saat.",
      },
    });
  });

  return app;
}
