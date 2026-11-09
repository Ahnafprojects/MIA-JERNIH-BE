import { timingSafeEqual } from "node:crypto";

import express from "express";
import pino from "pino";
import { z } from "zod";

import { Antrean } from "./antrean.js";
import { env } from "./env.js";
import { PengirimTelegram } from "./pengirim/telegram.js";
import { PengirimWa } from "./pengirim/wa.js";

const log = pino({ level: env.logLevel });

const antrean = new Antrean(log);
const wa = new PengirimWa(log.child({ saluran: "wa" }));
const telegram = new PengirimTelegram(log.child({ saluran: "telegram" }));

if (env.waAktif) antrean.daftarkan(wa);
antrean.daftarkan(telegram);

const app = express();
// Pesan notifikasi pendek. Batas kecil supaya satu permintaan salah bentuk
// tidak bisa memaksa layanan ini menelan muatan besar.
app.use(express.json({ limit: "64kb" }));

/**
 * Pemeriksaan rahasia bersama.
 *
 * Memakai `timingSafeEqual`, bukan `===`. Perbandingan string biasa berhenti
 * di karakter pertama yang berbeda, dan selisih waktunya bisa dipakai menebak
 * rahasianya karakter demi karakter. Layanan ini memegang sesi WhatsApp
 * nomor sungguhan, jadi pintunya tidak boleh dibuka semurah itu.
 */
function rahasiaCocok(diberikan: string | undefined): boolean {
  if (!diberikan) return false;
  const a = Buffer.from(diberikan);
  const b = Buffer.from(env.rahasia);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function butuhRahasia(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!rahasiaCocok(req.header("x-notifikasi-secret") ?? undefined)) {
    res.status(401).json({ galat: "Rahasia tidak cocok." });
    return;
  }
  next();
}

/* ── Kesehatan ─────────────────────────────────────────────────────────
 *
 * Sengaja TANPA rahasia dan sengaja tidak membocorkan apa pun: ia hanya
 * menjawab bahwa prosesnya hidup. Dipakai `depends_on` dan pemeriksaan
 * kontainer, yang keduanya tidak memegang rahasia.
 */
app.get("/sehat", (_req, res) => {
  res.json({ hidup: true });
});

app.get("/status", butuhRahasia, (_req, res) => {
  res.json(antrean.keadaan());
});

/**
 * QR pemasangan WhatsApp.
 *
 * Dilindungi rahasia. Siapa pun yang memindai QR ini memasangkan PERANGKAT
 * BARU pada nomor WhatsApp tim, dan perangkat itu bisa membaca serta
 * mengirim pesan atas nama nomor tersebut. Ini endpoint paling berbahaya di
 * layanan ini, dan karena itu layanannya tidak pernah diekspos ke internet.
 */
app.get("/qr", butuhRahasia, async (_req, res) => {
  const png = await wa.qrPng();
  if (!png) {
    res.status(404).json({
      galat: wa.siap()
        ? "WhatsApp sudah tersambung, tidak ada QR yang perlu dipindai."
        : "QR belum tersedia. Tunggu beberapa detik lalu coba lagi.",
    });
    return;
  }
  // Halaman kecil, bukan JSON: yang membukanya manusia dengan ponsel di
  // tangan, dan data URL mentah tidak bisa dipindai.
  res.type("html").send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Pindai QR WhatsApp Jernih</title>
     <body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f8f9;color:#08222c">
       <div style="text-align:center">
         <h1 style="font-size:1.1rem">Pindai dengan WhatsApp nomor Jernih</h1>
         <p style="font-size:.85rem;color:#46626c">WhatsApp → Perangkat Tertaut → Tautkan Perangkat</p>
         <img src="${png}" width="320" height="320" alt="QR pemasangan">
         <p style="font-size:.75rem;color:#46626c">Halaman ini menyegarkan sendiri tiap 20 detik.</p>
       </div>
       <script>setTimeout(() => location.reload(), 20000)</script>
     </body>`,
  );
});

const skemaKirim = z.object({
  /** Kunci idempotensi dari pemanggil, mis. `tiket:JRN-00123:SELESAI`. */
  kunci: z.string().min(4).max(200),
  saluran: z.enum(["wa", "telegram"]),
  tujuan: z.string().min(3).max(64),
  pesan: z.string().min(1).max(4000),
});

app.post("/kirim", butuhRahasia, (req, res) => {
  const hasil = skemaKirim.safeParse(req.body);
  if (!hasil.success) {
    res.status(400).json({
      galat: "Bentuk permintaan salah.",
      rinci: hasil.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { kunci, saluran, tujuan, pesan } = hasil.data;
  const baru = antrean.titip(kunci, saluran, tujuan, pesan);

  /*
   * 202, bukan 200: pesannya DITITIPKAN, belum terkirim. Membalas 200 di sini
   * akan membuat pemanggil mengira pesannya sudah sampai, padahal WhatsApp
   * bisa saja sedang menyambung ulang dan baru mengirimnya semenit kemudian.
   */
  res.status(202).json({ dititipkan: true, baru });
});

/**
 * Menukar kode penghubung Telegram jadi chat id.
 *
 * Warga menekan Start di bot, bot memberi kode enam digit, warga menempelkan
 * kode itu di portal. Backend memanggil endpoint ini untuk menukarnya, lalu
 * MENYIMPAN chat id-nya sendiri. Layanan ini tidak menyimpan kaitan apa pun
 * antara warga dan chat id — ia tidak tahu dan tidak perlu tahu siapa
 * penggunanya.
 */
app.post("/telegram/tukar-kode", butuhRahasia, (req, res) => {
  const skema = z.object({ kode: z.string().regex(/^\d{6}$/) });
  const hasil = skema.safeParse(req.body);
  if (!hasil.success) {
    res.status(400).json({ galat: "Kode harus enam digit angka." });
    return;
  }

  const chatId = telegram.tukarKode(hasil.data.kode);
  if (chatId === null) {
    res.status(404).json({
      galat: "Kode tidak dikenal atau sudah kedaluwarsa. Kirim /start lagi ke bot.",
    });
    return;
  }

  res.json({ chatId: String(chatId) });
});

async function mulai(): Promise<void> {
  // Server HTTP dinyalakan LEBIH DULU, sebelum WhatsApp dan Telegram.
  // Penyambungan WhatsApp bisa memakan puluhan detik dan bisa berakhir
  // menunggu pemindaian QR; kalau server menunggunya, endpoint /qr yang
  // dibutuhkan untuk memindai justru belum hidup.
  app.listen(env.port, "0.0.0.0", () => {
    log.info({ port: env.port }, "layanan notifikasi mendengarkan");
  });

  if (env.waAktif) {
    wa.mulai().catch((e) => log.error({ err: String(e) }, "WhatsApp gagal mulai"));
  } else {
    log.warn("WA_AKTIF=false, saluran WhatsApp dimatikan.");
  }

  telegram
    .mulai()
    .catch((e) => log.error({ err: String(e) }, "Telegram gagal mulai"));
}

void mulai();
