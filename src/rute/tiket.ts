/**
 * Modul pengaduan warga (tiket) dan perhitungan SLA.
 * Sesuai spesifikasi Issue #6.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { StatusTiket } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { wajibMasuk, wajibPeran } from "../middleware/sesi.js";
import { emailTiketDiperbarui, kirimEmail } from "../lib/email.js";

export const tiketRouter: Router = Router();
export const adminTiketRouter: Router = Router();

/* ── Standar Jam SLA per Kategori ────────────────────────────────────── */

export const JAM_SLA_KATEGORI: Record<string, number> = {
  "kebocoran pipa": 6,
  "air tidak mengalir": 12,
  "air keruh/berbau": 24,
  "tekanan lemah": 24,
  "meter/keypad rusak": 48,
  lainnya: 72,
};

export function hitungSlaJatuhTempo(kategori: string, tanggalDibuat: Date): Date {
  const kunci = kategori.toLowerCase();
  const jamSla = JAM_SLA_KATEGORI[kunci] ?? 48;
  return new Date(tanggalDibuat.getTime() + jamSla * 60 * 60 * 1000);
}

/**
 * Nomor urut tiket berikutnya untuk bulan berjalan.
 *
 * Versi sebelumnya membaca tiket terakhir lalu menambah satu di memori. Itu
 * balapan klasik: delapan pengaduan yang tiba bersamaan menghasilkan SATU
 * nomor yang sama (sudah diuji), dan karena `Tiket.nomor` ber-`@unique`,
 * tujuh di antaranya gagal dengan 500 — tepat pada saat gangguan besar,
 * ketika banyak warga melapor serentak.
 *
 * `padStart(4)` juga dipertahankan hanya sebagai lebar minimum. Dulu lebarnya
 * mengikat: tiket ke-10.000 menghasilkan "…-10000", yang pada urutan STRING
 * jatuh di bawah "…-9999", sehingga penomoran berputar balik dan bertabrakan.
 * Di sini urutan dihitung dari JUMLAH baris, bukan dari urutan string.
 */
async function nomorBerikutnya(awalan: string): Promise<string> {
  const jumlah = await prisma.tiket.count({ where: { nomor: { startsWith: awalan } } });
  return `${awalan}${String(jumlah + 1).padStart(4, "0")}`;
}

export async function buatNomorTiket(): Promise<string> {
  const d = new Date();
  const thn = d.getFullYear();
  const bln = String(d.getMonth() + 1).padStart(2, "0");
  return nomorBerikutnya(`LP-${thn}-${bln}-`);
}

/**
 * Membuat tiket sambil menangani tabrakan nomor.
 *
 * Keunikan ditegakkan basis data, bukan oleh pembacaan di atas: kalau dua
 * permintaan tetap memilih nomor yang sama, yang kalah mendapat P2002 dan
 * mencoba lagi dengan nomor berikutnya. Itu sebabnya nomor TIDAK boleh
 * dihitung sekali di luar lalu dipakai berulang.
 */
export async function buatTiketDenganNomor<T>(
  buat: (nomor: string) => Promise<T>,
  maksCoba = 8,
): Promise<T> {
  const d = new Date();
  const awalan = `LP-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-`;

  let urut = (await prisma.tiket.count({ where: { nomor: { startsWith: awalan } } })) + 1;
  for (let coba = 0; coba < maksCoba; coba++) {
    try {
      return await buat(`${awalan}${String(urut).padStart(4, "0")}`);
    } catch (err) {
      const kode = (err as { code?: string }).code;
      const target = (err as { meta?: { target?: string[] } }).meta?.target;
      const bentrokNomor =
        kode === "P2002" && (!target || target.includes("nomor"));
      if (!bentrokNomor) throw err;
      urut++;
    }
  }
  throw new Error(
    `Gagal memperoleh nomor tiket unik setelah ${maksCoba} percobaan.`,
  );
}

/* ── Validasi Zod ────────────────────────────────────────────────────── */

const skemaBuatTiket = z.object({
  kategori: z.string().trim().min(3, "Kategori pengaduan wajib dipilih."),
  deskripsi: z.string().trim().min(5, "Deskripsi pengaduan minimal 5 karakter."),
  foto: z.array(z.string()).max(3, "Maksimal 3 foto pendukung.").default([]),
  lat: z.number().optional(),
  lng: z.number().optional(),
  meterId: z.string().trim().optional(),
});

const skemaUbahTiketAdmin = z.object({
  status: z.enum(["BARU", "DIPROSES", "SELESAI"]),
  teknisiId: z.string().trim().optional(),
  catatan: z.string().trim().optional(),
});

tiketRouter.use(wajibMasuk);
adminTiketRouter.use(wajibMasuk);

/* ── 1. POST /api/tiket ──────────────────────────────────────────────── */

tiketRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = skemaBuatTiket.parse(req.body);
    const pelaporId = req.pengguna!.id;

    // Validasi foto (maks 3 foto, masing-masing <= 5MB bila base64)
    for (const f of data.foto) {
      if (f.startsWith("data:") && f.length > 7_000_000) {
        throw badRequest("FOTO_TERLALU_BESAR", "Ukuran foto maksimal 5 MB per berkas.");
      }
    }

    const dibuatPada = new Date();
    const slaJatuhTempo = hitungSlaJatuhTempo(data.kategori, dibuatPada);

    const tiket = await buatTiketDenganNomor((nomor) =>
      prisma.tiket.create({
        data: {
          nomor,
          pelaporId,
          kategori: data.kategori,
          deskripsi: data.deskripsi,
          fotoUrl: data.foto,
          lat: data.lat ?? null,
          lng: data.lng ?? null,
          meterId: data.meterId ?? null,
          status: StatusTiket.BARU,
          slaJatuhTempo,
          dibuatPada,
        },
      }),
    );

    res.status(201).json({
      ok: true,
      tiket: {
        id: tiket.id,
        nomor: tiket.nomor,
        kategori: tiket.kategori,
        deskripsi: tiket.deskripsi,
        status: tiket.status,
        slaJatuhTempo: tiket.slaJatuhTempo.toISOString(),
        dibuatPada: tiket.dibuatPada.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── 2. GET /api/tiket ───────────────────────────────────────────────── */

tiketRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pelaporId = req.pengguna!.id;

    const daftarTiket = await prisma.tiket.findMany({
      where: { pelaporId },
      orderBy: { dibuatPada: "desc" },
      include: {
        meter: { select: { id: true, serial: true } },
      },
    });

    const sekarang = Date.now();

    res.status(200).json({
      tiket: daftarTiket.map((t) => {
        const slaTerlampaui = t.selesaiPada
          ? t.selesaiPada.getTime() > t.slaJatuhTempo.getTime()
          : sekarang > t.slaJatuhTempo.getTime();

        return {
          id: t.id,
          nomor: t.nomor,
          kategori: t.kategori,
          deskripsi: t.deskripsi,
          status: t.status,
          meterId: t.meterId,
          slaJatuhTempo: t.slaJatuhTempo.toISOString(),
          slaTerlampaui,
          dibuatPada: t.dibuatPada.toISOString(),
          selesaiPada: t.selesaiPada?.toISOString() ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/* ── 3. GET /api/tiket/:id ───────────────────────────────────────────── */

tiketRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw notFound("ID tiket tidak valid.");

    const tiket = await prisma.tiket.findFirst({
      where: {
        OR: [{ id }, { nomor: id }],
      },
      include: {
        meter: true,
        pelapor: { select: { id: true, nama: true, email: true } },
        teknisi: { select: { id: true, nama: true, hp: true } },
      },
    });

    if (!tiket) {
      throw notFound("Tiket pengaduan tidak ditemukan.");
    }

    if (req.pengguna!.peran === "WARGA" && tiket.pelaporId !== req.pengguna!.id) {
      throw forbidden("Anda tidak berhak melihat tiket pengaduan orang lain.");
    }

    const sekarang = Date.now();
    const slaTerlampaui = tiket.selesaiPada
      ? tiket.selesaiPada.getTime() > tiket.slaJatuhTempo.getTime()
      : sekarang > tiket.slaJatuhTempo.getTime();

    // Kronologi
    const kronologi: Array<{ waktu: string; judul: string }> = [
      {
        waktu: tiket.dibuatPada.toISOString(),
        judul: "Laporan pengaduan diterima sistem",
      },
    ];

    if (tiket.status === "DIPROSES" || tiket.status === "SELESAI") {
      kronologi.push({
        waktu: tiket.diubahPada.toISOString(),
        judul: `Ditugaskan kepada teknisi${tiket.teknisi ? ` (${tiket.teknisi.nama})` : ""}`,
      });
    }

    if (tiket.status === "SELESAI" && tiket.selesaiPada) {
      kronologi.push({
        waktu: tiket.selesaiPada.toISOString(),
        judul: "Pengaduan selesai ditangani dan diverifikasi",
      });
    }

    res.status(200).json({
      tiket: {
        id: tiket.id,
        nomor: tiket.nomor,
        kategori: tiket.kategori,
        deskripsi: tiket.deskripsi,
        fotoUrl: tiket.fotoUrl,
        lat: tiket.lat,
        lng: tiket.lng,
        status: tiket.status,
        meterId: tiket.meterId,
        slaJatuhTempo: tiket.slaJatuhTempo.toISOString(),
        slaTerlampaui,
        dibuatPada: tiket.dibuatPada.toISOString(),
        diubahPada: tiket.diubahPada.toISOString(),
        selesaiPada: tiket.selesaiPada?.toISOString() ?? null,
        kronologi,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── 4. GET /api/admin/tiket?status=&zona= ───────────────────────────── */

adminTiketRouter.get(
  "/",
  wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string | undefined;
      const zona = req.query.zona as string | undefined;

      const where: { status?: StatusTiket; meter?: { zonaId: string } } = {};
      if (status) where.status = status.toUpperCase() as StatusTiket;
      if (zona) where.meter = { zonaId: zona };

      const list = await prisma.tiket.findMany({
        where,
        orderBy: { dibuatPada: "desc" },
        include: {
          pelapor: { select: { nama: true, email: true, hp: true } },
          teknisi: { select: { nama: true } },
          meter: { select: { id: true, serial: true, zona: { select: { nama: true } } } },
        },
      });

      const sekarang = Date.now();

      res.status(200).json({
        tiket: list.map((t) => ({
          id: t.id,
          nomor: t.nomor,
          kategori: t.kategori,
          deskripsi: t.deskripsi,
          status: t.status,
          zona: t.meter?.zona?.nama ?? null,
          pelapor: t.pelapor,
          teknisi: t.teknisi?.nama ?? null,
          slaJatuhTempo: t.slaJatuhTempo.toISOString(),
          slaTerlampaui: t.selesaiPada
            ? t.selesaiPada.getTime() > t.slaJatuhTempo.getTime()
            : sekarang > t.slaJatuhTempo.getTime(),
          dibuatPada: t.dibuatPada.toISOString(),
          selesaiPada: t.selesaiPada?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ── 5. PATCH /api/admin/tiket/:id ───────────────────────────────────── */

adminTiketRouter.patch(
  "/:id",
  wajibPeran("OPERATOR", "SUPERVISOR", "TEKNISI"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!id) throw notFound("ID tiket tidak valid.");

      const { status, teknisiId, catatan } = skemaUbahTiketAdmin.parse(req.body);

      const tiket = await prisma.tiket.findUnique({
        where: { id },
        include: { pelapor: true },
      });

      if (!tiket) {
        throw notFound("Tiket tidak ditemukan.");
      }

      const statusLama = tiket.status;
      const statusBaru = status;
      const selesaiPada =
        statusBaru === StatusTiket.SELESAI ? new Date() : tiket.selesaiPada;

      const updated = await prisma.tiket.update({
        where: { id },
        data: {
          status: statusBaru,
          teknisiId: teknisiId ?? tiket.teknisiId,
          selesaiPada,
        },
      });

      // Catat ke AuditLog
      await prisma.auditLog.create({
        data: {
          aktorId: req.pengguna!.id,
          aktorNama: req.pengguna!.id,
          aksi: `TIKET_${statusBaru}`,
          detail: `Status tiket ${tiket.nomor} diubah dari ${statusLama} ke ${statusBaru}.${catatan ? ` Catatan: ${catatan}` : ""}`,
          tipe: "TIKET",
          ip: req.ip ?? "127.0.0.1",
        },
      });

      // Kirim email notifikasi ke pelapor
      if (tiket.pelapor?.email) {
        await kirimEmail(
          emailTiketDiperbarui(
            tiket.pelapor.email,
            tiket.nomor,
            statusLama,
            statusBaru,
            catatan,
          ),
        );
      }

      res.status(200).json({
        ok: true,
        tiket: updated,
      });
    } catch (err) {
      next(err);
    }
  },
);
