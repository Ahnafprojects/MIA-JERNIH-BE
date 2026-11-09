/**
 * Penyambungan notifikasi pada perubahan status tiket, diuji lewat RUTE-nya.
 *
 * Berbeda dari `pesan-notifikasi.test.ts` yang menguji fungsinya satu per
 * satu, berkas ini memanggil `PATCH /api/admin/tiket/:id` sungguhan. Yang
 * dibuktikan di sini cuma bisa dibuktikan dari sisi rute:
 *
 *   1. Kolom persetujuan ikut terbawa kueri. `kabariWarga` memeriksa
 *      `waOptIn` dan `waNomor`, tetapi kalau kuerinya tidak mengambil kolom
 *      itu, nilainya `undefined` dan tidak ada pesan yang terkirim. Gejalanya
 *      "fitur tidak jalan" tanpa satu pun galat, dan uji unit tidak akan
 *      pernah menangkapnya.
 *   2. Kegagalan notifikasi tidak menggagalkan perubahan status.
 *
 * ── Kenapa ada penantian ─────────────────────────────────────────────
 *
 * Notifikasinya dipanggil dengan `void`, tanpa `await`, supaya petugas tidak
 * menunggu antrean WhatsApp. Akibatnya, saat balasan HTTP kembali, `fetch`
 * belum tentu sudah terjadi. Menguji tanpa menanti akan lolos hari ini dan
 * gagal acak besok.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";

/** Memberi kesempatan pekerjaan `void` yang tertunda untuk berjalan. */
const biarkanTertunda = () => new Promise((r) => setTimeout(r, 50));

interface Sadapan {
  panggilan: Array<{ kunci: string; saluran: string; tujuan: string }>;
}

function sadapFetch(gagal = false): Sadapan {
  const panggilan: Sadapan["panggilan"] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, opsi: { body?: string }) => {
      if (opsi?.body) panggilan.push(JSON.parse(opsi.body));
      if (gagal) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ dititipkan: true, baru: true }), {
        status: 202,
      });
    }),
  );
  return { panggilan };
}

async function siapkanTiket(opsi: {
  waOptIn: boolean;
  waNomor: string | null;
  telegramChatId: string | null;
}) {
  const cap = Date.now() + Math.floor(Math.random() * 10_000);

  const operator = await prisma.pengguna.create({
    data: {
      nama: "Operator Notifikasi",
      email: `op_notif_${cap}@test.id`,
      kataSandiHash: "hash123",
      peran: "OPERATOR",
    },
  });

  const pelapor = await prisma.pengguna.create({
    data: {
      nama: "Warga Notifikasi",
      email: `warga_notif_${cap}@test.id`,
      kataSandiHash: "hash123",
      peran: "WARGA",
      waOptIn: opsi.waOptIn,
      waNomor: opsi.waNomor,
      telegramChatId: opsi.telegramChatId,
    },
  });

  const tiket = await prisma.tiket.create({
    data: {
      nomor: `LP-NOTIF-${cap}`,
      pelaporId: pelapor.id,
      kategori: "kebocoran pipa",
      deskripsi: "Pipa bocor di depan rumah",
      status: "BARU",
      slaJatuhTempo: new Date(Date.now() + 6 * 60 * 60 * 1000),
    },
  });

  const tokenOp = await buatAkses({ sub: operator.id, peran: "OPERATOR" });
  return { pelapor, tiket, tokenOp };
}

describe("Notifikasi pada perubahan status tiket", () => {
  const app = buatApp();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pelapor yang menyetujui WhatsApp dikirimi, dengan kunci dari nomor tiket", async () => {
    const { tiket, tokenOp } = await siapkanTiket({
      waOptIn: true,
      waNomor: "6281252961135",
      telegramChatId: null,
    });
    const { panggilan } = sadapFetch();

    const res = await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({ status: "DIPROSES", catatan: "Teknisi meluncur" });

    expect(res.status).toBe(200);
    await biarkanTertunda();

    expect(panggilan).toHaveLength(1);
    expect(panggilan[0]!.saluran).toBe("wa");
    expect(panggilan[0]!.tujuan).toBe("6281252961135");
    // Kunci dari KEJADIANNYA: nomor tiket + status baru.
    expect(panggilan[0]!.kunci).toBe(`tiket:${tiket.nomor}:DIPROSES:wa`);
  });

  it("pelapor tanpa persetujuan tidak dikirimi apa pun", async () => {
    const { tiket, tokenOp } = await siapkanTiket({
      waOptIn: false,
      waNomor: "6281252961135",
      telegramChatId: null,
    });
    const { panggilan } = sadapFetch();

    const res = await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({ status: "SELESAI" });

    expect(res.status).toBe(200);
    await biarkanTertunda();

    expect(panggilan).toHaveLength(0);
  });

  it("status berbeda menghasilkan kunci berbeda, jadi dua perubahan dua pesan", async () => {
    const { tiket, tokenOp } = await siapkanTiket({
      waOptIn: true,
      waNomor: "6281252961135",
      telegramChatId: null,
    });
    const { panggilan } = sadapFetch();

    await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({ status: "DIPROSES" });
    await biarkanTertunda();

    await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({ status: "SELESAI" });
    await biarkanTertunda();

    expect(panggilan.map((p) => p.kunci)).toEqual([
      `tiket:${tiket.nomor}:DIPROSES:wa`,
      `tiket:${tiket.nomor}:SELESAI:wa`,
    ]);
  });

  it("notifikasi yang gagal TIDAK menggagalkan perubahan status", async () => {
    const { tiket, tokenOp } = await siapkanTiket({
      waOptIn: true,
      waNomor: "6281252961135",
      telegramChatId: "12345",
    });
    sadapFetch(true); // setiap permintaan melempar

    const res = await request(app)
      .patch(`/api/admin/tiket/${tiket.id}`)
      .set("Authorization", `Bearer ${tokenOp}`)
      .send({ status: "SELESAI", catatan: "Sudah diperbaiki" });

    // Petugas tetap melihat keberhasilan.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await biarkanTertunda();

    // Dan statusnya benar-benar tersimpan.
    const sesudah = await prisma.tiket.findUnique({ where: { id: tiket.id } });
    expect(sesudah?.status).toBe("SELESAI");
    expect(sesudah?.selesaiPada).not.toBeNull();
  });
});
