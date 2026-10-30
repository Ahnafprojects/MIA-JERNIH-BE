/**
 * Modul autentikasi, sesi, dan verifikasi email.
 * Sesuai spesifikasi Issue #1.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  buatAkses,
  buatKodeEmail,
  buatRefresh,
  hashKode,
  hashRefresh,
  hashSandi,
  kodeCocok,
  sandiCocok,
} from "../lib/auth.js";
import {
  badRequest,
  notFound,
  unauthorized,
} from "../lib/errors.js";
import { wajibMasuk } from "../middleware/sesi.js";
import {
  emailMasukBaru,
  emailVerifikasiDaftar,
  emailLupaSandi,
  kirimEmail,
} from "../lib/email.js";
import { env } from "../env.js";

export const authRouter: Router = Router();
export const meRouter: Router = Router();

/* ── Rate Limiter ────────────────────────────────────────────────────── */

const buatLimiter = (limit: number, pesan: string) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: "RATE_LIMIT", message: pesan } }),
  });

const limiterMasuk = buatLimiter(
  20,
  "Terlalu banyak percobaan masuk. Coba lagi dalam 1 menit.",
);

/**
 * Untuk endpoint yang MEMVERIFIKASI kredensial pendek (kode 6 digit, token
 * atur ulang). Sebelumnya tidak ada satu pun limiter di sini, sehingga kode
 * 6 digit bisa disisir habis selama masa berlakunya 10 menit — terbukti 60
 * tebakan berturut-turut tanpa satu pun ditahan, lalu kode benar tetap
 * memberi sesi penuh.
 */
const limiterKode = buatLimiter(
  10,
  "Terlalu banyak percobaan kode. Coba lagi dalam 1 menit.",
);

/** Untuk endpoint yang MEMICU pengiriman email, supaya tidak jadi relai spam. */
const limiterKirim = buatLimiter(
  5,
  "Terlalu banyak permintaan kode. Coba lagi dalam 1 menit.",
);

/**
 * Batas tebakan per kode, ditegakkan di tingkat basis data.
 *
 * Kolom `KodeEmail.percobaan` sudah ada dan sudah dinaikkan tiap tebakan
 * salah, tapi TIDAK PERNAH dibaca di mana pun — jadi penghitungnya hanya
 * mencatat serangan tanpa menghentikannya. Rate limiter per IP saja tidak
 * cukup: penyerang bisa berganti IP, sedangkan batas ini menempel pada
 * kodenya sendiri. Nilai 5 menyamai aturan penukaran token di `token.ts`.
 */
const MAKS_PERCOBAAN_KODE = 5;

/** Melempar kalau kode sudah terlalu sering ditebak. */
function pastikanBelumHabisPercobaan(percobaan: number) {
  if (percobaan >= MAKS_PERCOBAAN_KODE) {
    throw unauthorized(
      "Kode ini sudah terlalu sering dicoba. Minta kode baru.",
      "KODE_TERKUNCI",
    );
  }
}

/* ── Skema Validasi Zod ──────────────────────────────────────────────── */

const skemaDaftar = z.object({
  nama: z.string().trim().min(2, "Nama minimal 2 karakter."),
  email: z.string().trim().email("Format email tidak valid.").toLowerCase(),
  hp: z.string().trim().optional(),
  kataSandi: z.string().min(8, "Kata sandi minimal 8 karakter."),
});

const skemaVerifikasi = z.object({
  email: z.string().trim().email().toLowerCase(),
  kode: z.string().trim().length(6, "Kode verifikasi harus 6 digit."),
});

const skemaKirimUlang = z.object({
  email: z.string().trim().email().toLowerCase(),
  tujuan: z.enum(["daftar", "masuk", "lupa"]).default("daftar"),
});

const skemaMasuk = z.object({
  email: z.string().trim().email("Email tidak valid.").toLowerCase(),
  kataSandi: z.string().min(1, "Kata sandi wajib diisi."),
  ingat: z.boolean().optional(),
});

const skemaMasukKode = z.object({
  email: z.string().trim().email().toLowerCase(),
  kode: z.string().trim().length(6, "Kode verifikasi harus 6 digit."),
});

const skemaLupa = z.object({
  email: z.string().trim().email().toLowerCase(),
});

const skemaAturUlang = z.object({
  /*
   * Minimal 32 karakter — BUKAN 6.
   *
   * `buatRefresh()` menghasilkan 32 byte base64url (43 karakter), jadi batas
   * ini tidak menolak token yang sah. Yang ditolaknya adalah nilai sependek
   * kode 6 digit: dengan `min(6)` sebelumnya, kode email bisa dipakai sebagai
   * token atur ulang dan ruang tebakannya hanya sejuta.
   */
  token: z.string().trim().min(32, "Token atur ulang tidak valid."),
  kataSandiBaru: z.string().min(8, "Kata sandi baru minimal 8 karakter."),
});

/* ── Helper Sesi & Cookie ────────────────────────────────────────────── */

function pasangCookieRefresh(res: Response, refreshToken: string) {
  const cfg = env();
  const durasiMs = cfg.REFRESH_TTL_HARI * 24 * 60 * 60 * 1000;
  res.cookie("refresh", refreshToken, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: durasiMs,
  });
}

function ambilRefreshToken(req: Request): string | null {
  const dariCookie = (req.cookies as Record<string, string> | undefined)?.refresh;
  if (dariCookie) return dariCookie;
  const kepala = req.headers["x-refresh-token"];
  if (typeof kepala === "string" && kepala.trim()) return kepala.trim();
  return null;
}

/* ── 1. POST /api/auth/daftar ────────────────────────────────────────── */

authRouter.post("/daftar", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = skemaDaftar.parse(req.body);

    const penggunaAda = await prisma.pengguna.findUnique({
      where: { email: data.email },
    });

    if (penggunaAda && penggunaAda.emailTerverifikasiPada) {
      throw badRequest("EMAIL_TERDAFTAR", "Email sudah terdaftar. Silakan masuk.");
    }

    const sandiHash = await hashSandi(data.kataSandi);
    let penggunaId = penggunaAda?.id;

    if (penggunaAda) {
      // Perbarui sandi akun yang belum sempat verifikasi
      await prisma.pengguna.update({
        where: { id: penggunaAda.id },
        data: {
          nama: data.nama,
          kataSandiHash: sandiHash,
          hp: data.hp ?? null,
        },
      });
    } else {
      const penggunaBaru = await prisma.pengguna.create({
        data: {
          nama: data.nama,
          email: data.email,
          kataSandiHash: sandiHash,
          hp: data.hp ?? null,
        },
      });
      penggunaId = penggunaBaru.id;
    }

    // Buat kode 6 digit verifikasi (10 menit)
    const kode = buatKodeEmail();
    const kodeHash = hashKode(kode);
    const kedaluwarsaPada = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.kodeEmail.create({
      data: {
        penggunaId: penggunaId ?? null,
        email: data.email,
        kodeHash,
        tujuan: "daftar",
        kedaluwarsaPada,
      },
    });

    // Kirim email (mock saat MAIL_ENABLED=false)
    await kirimEmail(emailVerifikasiDaftar(data.email, kode));

    res.status(200).json({
      step: "VERIFIKASI_EMAIL",
      email: data.email,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. POST /api/auth/verifikasi-email ──────────────────────────────── */

authRouter.post(
  "/verifikasi-email",
  limiterKode,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, kode } = skemaVerifikasi.parse(req.body);

      const kodeRecord = await prisma.kodeEmail.findFirst({
        where: { email, tujuan: "daftar" },
        orderBy: { dibuatPada: "desc" },
      });

      if (!kodeRecord) {
        throw badRequest("KODE_TIDAK_DITEMUKAN", "Kode verifikasi tidak ditemukan.");
      }

      if (kodeRecord.dipakaiPada) {
        throw badRequest("KODE_SUDAH_DIPAKAI", "Kode verifikasi sudah pernah digunakan.");
      }

      if (kodeRecord.kedaluwarsaPada.getTime() < Date.now()) {
        throw badRequest("KODE_KEDALUWARSA", "Kode verifikasi sudah kedaluwarsa.");
      }

      pastikanBelumHabisPercobaan(kodeRecord.percobaan);

      const cocok = kodeCocok(kodeRecord.kodeHash, kode);
      if (!cocok) {
        await prisma.kodeEmail.update({
          where: { id: kodeRecord.id },
          data: { percobaan: { increment: 1 } },
        });
        throw badRequest("KODE_SALAH", "Kode verifikasi salah.");
      }

      await prisma.kodeEmail.update({
        where: { id: kodeRecord.id },
        data: { dipakaiPada: new Date() },
      });

      const pengguna = await prisma.pengguna.update({
        where: { email },
        data: { emailTerverifikasiPada: new Date() },
        select: {
          id: true,
          nama: true,
          email: true,
          peran: true,
          hp: true,
          alamat: true,
        },
      });

      // Buat sesi login
      const refreshToken = buatRefresh();
      const refHash = hashRefresh(refreshToken);
      const expiredSesi = new Date(
        Date.now() + env().REFRESH_TTL_HARI * 24 * 60 * 60 * 1000,
      );

      await prisma.sesi.create({
        data: {
          penggunaId: pengguna.id,
          refreshHash: refHash,
          perangkat: req.headers["user-agent"] ?? "unknown",
          ip: req.ip ?? "127.0.0.1",
          kedaluwarsaPada: expiredSesi,
        },
      });

      pasangCookieRefresh(res, refreshToken);

      const accessToken = await buatAkses({
        sub: pengguna.id,
        peran: pengguna.peran,
      });

      res.status(200).json({
        accessToken,
        pengguna,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 3. POST /api/auth/kirim-ulang-kode ──────────────────────────────── */

authRouter.post(
  "/kirim-ulang-kode",
  limiterKirim,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, tujuan } = skemaKirimUlang.parse(req.body);

      // Cek cooldown 60 detik
      const kodeTerakhir = await prisma.kodeEmail.findFirst({
        where: { email, tujuan },
        orderBy: { dibuatPada: "desc" },
      });

      if (
        kodeTerakhir &&
        Date.now() - kodeTerakhir.dibuatPada.getTime() < 60_000
      ) {
        res.status(429).json({
          error: {
            code: "TERLALU_SERING",
            message: "Tunggu 60 detik sebelum meminta kode baru.",
          },
        });
        return;
      }

      const pengguna = await prisma.pengguna.findUnique({
        where: { email },
      });

      /*
       * "lupa" TIDAK BOLEH memakai kode 6 digit.
       *
       * Sebelumnya cabang ini menyimpan kode 6 digit lalu mengirim tautan
       * `.../atur-ulang?t=<kode>`. Karena `hashKode()` dan `hashRefresh()`
       * sama-sama sha256 polos, kode itu diterima utuh oleh `/atur-ulang` —
       * yang mencari hash di SELURUH tabel tanpa menyebut email siapa pun.
       * Hasilnya: penyerang cukup menebak 6 digit, tanpa tahu email korban,
       * untuk mengambil alih akun. Terbukti bisa.
       *
       * Sekarang cabang ini memakai token acak 32 byte dengan masa 30 menit,
       * persis seperti POST /api/auth/lupa.
       */
      const kedaluwarsaPada = new Date(
        Date.now() + (tujuan === "lupa" ? 30 : 10) * 60 * 1000,
      );
      const rahasia = tujuan === "lupa" ? buatRefresh() : buatKodeEmail();

      await prisma.kodeEmail.create({
        data: {
          penggunaId: pengguna?.id ?? null,
          email,
          kodeHash: tujuan === "lupa" ? hashRefresh(rahasia) : hashKode(rahasia),
          tujuan,
          kedaluwarsaPada,
        },
      });

      if (tujuan === "daftar") {
        await kirimEmail(emailVerifikasiDaftar(email, rahasia));
      } else if (tujuan === "masuk") {
        await kirimEmail(emailMasukBaru(email, rahasia));
      } else if (tujuan === "lupa") {
        // Nama parameternya `token`, sama dengan yang dibaca /atur-ulang.
        // Sebelumnya `?t=` — tidak cocok dengan apa pun di sisi mana pun.
        await kirimEmail(
          emailLupaSandi(
            email,
            `${env().APP_URL}/atur-ulang?token=${encodeURIComponent(rahasia)}`,
          ),
        );
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 4. POST /api/auth/masuk ────────────────────────────────────────── */

authRouter.post(
  "/masuk",
  limiterMasuk,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, kataSandi } = skemaMasuk.parse(req.body);

      const pengguna = await prisma.pengguna.findUnique({
        where: { email },
      });

      // Dummy hash agar timing response tidak bocor bila akun tidak ada
      const hashUji =
        pengguna?.kataSandiHash ??
        "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$c29tZXNhbHQ";
      const cocok = await sandiCocok(hashUji, kataSandi);

      if (!pengguna || !cocok) {
        throw unauthorized(
          "Email atau kata sandi salah.",
          "KREDENSIAL_SALAH",
        );
      }

      if (!pengguna.aktif) {
        throw unauthorized(
          "Akun Anda dinonaktifkan. Hubungi administrator.",
          "AKUN_NONAKTIF",
        );
      }

      if (!pengguna.emailTerverifikasiPada) {
        res.status(403).json({
          error: {
            code: "EMAIL_BELUM_VERIFIKASI",
            message: "Email Anda belum diverifikasi.",
          },
          step: "VERIFIKASI_EMAIL",
          email: pengguna.email,
        });
        return;
      }

      const ua = req.headers["user-agent"] ?? "unknown";
      // Cek apakah perangkat pernah digunakan oleh pengguna ini (walaupun sesi sebelumnya telah logout)
      const pernahPakaiPerangkatIni = await prisma.sesi.findFirst({
        where: {
          penggunaId: pengguna.id,
          perangkat: ua,
        },
      });

      // Jika user punya riwayat sesi sebelumnya dan perangkat ini BENAR-BENAR belum pernah dipakai,
      // kirim 2FA kode email untuk keamanan tambahan
      const totalSesi = await prisma.sesi.count({
        where: { penggunaId: pengguna.id },
      });

      if (totalSesi > 0 && !pernahPakaiPerangkatIni) {
        const kode = buatKodeEmail();
        await prisma.kodeEmail.create({
          data: {
            penggunaId: pengguna.id,
            email: pengguna.email,
            kodeHash: hashKode(kode),
            tujuan: "masuk",
            kedaluwarsaPada: new Date(Date.now() + 10 * 60 * 1000),
          },
        });
        await kirimEmail(emailMasukBaru(pengguna.email, kode));
        res.status(200).json({
          step: "KODE_EMAIL",
          email: pengguna.email,
        });
        return;
      }

      // Buat Sesi Baru
      const refreshToken = buatRefresh();
      const refHash = hashRefresh(refreshToken);
      const expiredSesi = new Date(
        Date.now() + env().REFRESH_TTL_HARI * 24 * 60 * 60 * 1000,
      );

      await prisma.sesi.create({
        data: {
          penggunaId: pengguna.id,
          refreshHash: refHash,
          perangkat: ua,
          ip: req.ip ?? "127.0.0.1",
          kedaluwarsaPada: expiredSesi,
        },
      });

      pasangCookieRefresh(res, refreshToken);

      const accessToken = await buatAkses({
        sub: pengguna.id,
        peran: pengguna.peran,
      });

      res.status(200).json({
        accessToken,
        pengguna: {
          id: pengguna.id,
          nama: pengguna.nama,
          email: pengguna.email,
          peran: pengguna.peran,
          hp: pengguna.hp,
          alamat: pengguna.alamat,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 5. POST /api/auth/masuk/kode ───────────────────────────────────── */

authRouter.post(
  "/masuk/kode",
  limiterKode,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, kode } = skemaMasukKode.parse(req.body);

      const kodeRecord = await prisma.kodeEmail.findFirst({
        where: { email, tujuan: "masuk" },
        orderBy: { dibuatPada: "desc" },
      });

      if (!kodeRecord) {
        throw unauthorized("Kode verifikasi masuk tidak ditemukan.", "KODE_SALAH");
      }

      if (kodeRecord.dipakaiPada) {
        throw unauthorized("Kode sudah pernah digunakan.", "KODE_SUDAH_DIPAKAI");
      }

      if (kodeRecord.kedaluwarsaPada.getTime() < Date.now()) {
        throw unauthorized("Kode verifikasi sudah kedaluwarsa.", "KODE_KEDALUWARSA");
      }

      // Endpoint ini memberi SESI PENUH kalau kodenya benar, jadi batas
      // tebakan di sini yang paling menentukan.
      pastikanBelumHabisPercobaan(kodeRecord.percobaan);

      if (!kodeCocok(kodeRecord.kodeHash, kode)) {
        await prisma.kodeEmail.update({
          where: { id: kodeRecord.id },
          data: { percobaan: { increment: 1 } },
        });
        throw unauthorized("Kode verifikasi salah.", "KODE_SALAH");
      }

      await prisma.kodeEmail.update({
        where: { id: kodeRecord.id },
        data: { dipakaiPada: new Date() },
      });

      const pengguna = await prisma.pengguna.findUnique({
        where: { email },
        select: {
          id: true,
          nama: true,
          email: true,
          peran: true,
          hp: true,
          alamat: true,
        },
      });

      if (!pengguna) {
        throw notFound("Pengguna tidak ditemukan.");
      }

      const refreshToken = buatRefresh();
      const refHash = hashRefresh(refreshToken);
      const expiredSesi = new Date(
        Date.now() + env().REFRESH_TTL_HARI * 24 * 60 * 60 * 1000,
      );

      await prisma.sesi.create({
        data: {
          penggunaId: pengguna.id,
          refreshHash: refHash,
          perangkat: req.headers["user-agent"] ?? "unknown",
          ip: req.ip ?? "127.0.0.1",
          kedaluwarsaPada: expiredSesi,
        },
      });

      pasangCookieRefresh(res, refreshToken);

      const accessToken = await buatAkses({
        sub: pengguna.id,
        peran: pengguna.peran,
      });

      res.status(200).json({
        accessToken,
        pengguna,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 6. POST /api/auth/lupa ─────────────────────────────────────────── */

authRouter.post("/lupa", limiterKirim, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = skemaLupa.parse(req.body);

    const pengguna = await prisma.pengguna.findUnique({
      where: { email },
    });

    if (pengguna) {
      const token = buatRefresh();
      const tokenHash = hashRefresh(token);
      await prisma.kodeEmail.create({
        data: {
          penggunaId: pengguna.id,
          email: pengguna.email,
          kodeHash: tokenHash,
          tujuan: "lupa",
          kedaluwarsaPada: new Date(Date.now() + 30 * 60 * 1000), // 30 menit
        },
      });

      const tautan = `${env().APP_URL}/atur-ulang?token=${encodeURIComponent(token)}`;
      await kirimEmail(emailLupaSandi(pengguna.email, tautan));
    }

    // Selalu balas ok: true agar email pengguna tidak bocor
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── 7. POST /api/auth/atur-ulang ────────────────────────────────────── */

authRouter.post("/atur-ulang", limiterKode, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, kataSandiBaru } = skemaAturUlang.parse(req.body);
    const tokenHash = hashRefresh(token);

    const kodeRecord = await prisma.kodeEmail.findFirst({
      where: { kodeHash: tokenHash, tujuan: "lupa" },
      orderBy: { dibuatPada: "desc" },
    });

    if (!kodeRecord || kodeRecord.dipakaiPada || kodeRecord.kedaluwarsaPada.getTime() < Date.now()) {
      throw badRequest("TOKEN_INVALID", "Tautan atur ulang tidak valid atau sudah kedaluwarsa.");
    }

    if (!kodeRecord.penggunaId) {
      throw badRequest("PENGGUNA_TIDAK_DITEMUKAN", "Pengguna tidak ditemukan.");
    }

    const sandiHash = await hashSandi(kataSandiBaru);

    await prisma.$transaction([
      prisma.pengguna.update({
        where: { id: kodeRecord.penggunaId },
        data: { kataSandiHash: sandiHash },
      }),
      prisma.kodeEmail.update({
        where: { id: kodeRecord.id },
        data: { dipakaiPada: new Date() },
      }),
      // Cabut seluruh sesi sebelumnya demi keamanan
      prisma.sesi.updateMany({
        where: { penggunaId: kodeRecord.penggunaId, dicabutPada: null },
        data: { dicabutPada: new Date() },
      }),
    ]);

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── 8. POST /api/auth/refresh ──────────────────────────────────────── */

authRouter.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = ambilRefreshToken(req);
    if (!refreshToken) {
      throw unauthorized("Refresh token tidak ditemukan.", "TOKEN_TIDAK_ADA");
    }

    const refHash = hashRefresh(refreshToken);
    const sesi = await prisma.sesi.findUnique({
      where: { refreshHash: refHash },
      include: { pengguna: true },
    });

    if (!sesi) {
      throw unauthorized("Sesi tidak ditemukan.", "SESI_TIDAK_VALID");
    }

    // Deteksi Token Reuse: jika sesi sudah dicabut lalu dicoba pakai lagi,
    // berarti token ini dicuri/bocor! Cabut seluruh sesi milik pengguna ini.
    if (sesi.dicabutPada) {
      await prisma.sesi.updateMany({
        where: { penggunaId: sesi.penggunaId, dicabutPada: null },
        data: { dicabutPada: new Date() },
      });
      res.clearCookie("refresh", { path: "/" });
      throw unauthorized(
        "Terdeteksi penggunaan ulang token sesi. Seluruh sesi Anda dicabut demi keamanan.",
        "SESI_DICABUT",
      );
    }

    if (sesi.kedaluwarsaPada.getTime() < Date.now()) {
      throw unauthorized("Sesi Anda sudah berakhir. Silakan masuk lagi.", "SESI_HABIS");
    }

    // Putar Refresh Token (Token Rotation)
    const tokenBaru = buatRefresh();
    const hashBaru = hashRefresh(tokenBaru);
    const expiredBaru = new Date(
      Date.now() + env().REFRESH_TTL_HARI * 24 * 60 * 60 * 1000,
    );

    await prisma.$transaction([
      // Cabut sesi lama
      prisma.sesi.update({
        where: { id: sesi.id },
        data: { dicabutPada: new Date() },
      }),
      // Terbitkan sesi baru
      prisma.sesi.create({
        data: {
          penggunaId: sesi.penggunaId,
          refreshHash: hashBaru,
          perangkat: req.headers["user-agent"] ?? sesi.perangkat,
          ip: req.ip ?? sesi.ip,
          kedaluwarsaPada: expiredBaru,
        },
      }),
    ]);

    pasangCookieRefresh(res, tokenBaru);

    const accessToken = await buatAkses({
      sub: sesi.pengguna.id,
      peran: sesi.pengguna.peran,
    });

    res.status(200).json({
      accessToken,
      pengguna: {
        id: sesi.pengguna.id,
        nama: sesi.pengguna.nama,
        email: sesi.pengguna.email,
        peran: sesi.pengguna.peran,
        hp: sesi.pengguna.hp,
        alamat: sesi.pengguna.alamat,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── 9. POST /api/auth/keluar ───────────────────────────────────────── */

authRouter.post("/keluar", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = ambilRefreshToken(req);
    if (refreshToken) {
      const refHash = hashRefresh(refreshToken);
      await prisma.sesi.updateMany({
        where: { refreshHash: refHash, dicabutPada: null },
        data: { dicabutPada: new Date() },
      });
    }

    res.clearCookie("refresh", { path: "/" });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── 10. GET /api/me ────────────────────────────────────────────────── */

meRouter.get("/", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const penggunaId = req.pengguna!.id;
    const pengguna = await prisma.pengguna.findUnique({
      where: { id: penggunaId },
      select: {
        id: true,
        nama: true,
        email: true,
        peran: true,
        hp: true,
        alamat: true,
        zonaId: true,
        golonganId: true,
        ambangPeringatanL: true,
        meter: true,
      },
    });

    if (!pengguna) {
      throw notFound("Pengguna tidak ditemukan.");
    }

    const { meter, ...dataPengguna } = pengguna;
    res.status(200).json({
      pengguna: dataPengguna,
      meter,
    });
  } catch (err) {
    next(err);
  }
});

/* ── 11. GET /api/me/sesi ───────────────────────────────────────────── */

meRouter.get("/sesi", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const penggunaId = req.pengguna!.id;
    const sesiList = await prisma.sesi.findMany({
      where: {
        penggunaId,
        dicabutPada: null,
        kedaluwarsaPada: { gt: new Date() },
      },
      select: {
        id: true,
        perangkat: true,
        ip: true,
        terakhirPada: true,
        dibuatPada: true,
      },
      orderBy: { terakhirPada: "desc" },
    });

    res.status(200).json({ sesi: sesiList });
  } catch (err) {
    next(err);
  }
});

/* ── 12. DELETE /api/me/sesi/:id ────────────────────────────────────── */

meRouter.delete("/sesi/:id", wajibMasuk, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const penggunaId = req.pengguna!.id;
    const id = req.params.id as string;
    if (!id) {
      throw notFound("Sesi tidak ditemukan.");
    }

    const sesi = await prisma.sesi.findFirst({
      where: { id, penggunaId },
    });

    if (!sesi) {
      throw notFound("Sesi tidak ditemukan.");
    }

    await prisma.sesi.update({
      where: { id },
      data: { dicabutPada: new Date() },
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
