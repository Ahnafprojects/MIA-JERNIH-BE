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

  // TODO(tim): daftarkan router di sini — lihat issue di repo ini.
  // app.use("/api", authRouter);
  // app.use("/api/publik", publikRouter);
  // app.use("/api/admin", adminRouter);

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
