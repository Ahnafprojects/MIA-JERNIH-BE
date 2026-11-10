/**
 * Penerima broadcast menurut `target`, dan penandaan baca sekaligus.
 *
 * Sebelumnya `target` hanya disimpan: "Saldo rendah" tetap
 * dikirim ke seluruh warga, sementara riwayat broadcast mencatat target yang
 * dipilih seolah penyaringannya terjadi. Uji di sini memeriksa SIAPA yang
 * menerima, bukan sekadar berapa, karena basis data uji juga memuat warga
 * dari berkas uji lain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Peran } from "@prisma/client";
import { buatApp } from "../src/app.js";
import { buatAkses } from "../src/lib/auth.js";
import { prisma } from "../src/lib/prisma.js";

const app = buatApp();
const unik = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

let tokenSpv = "";
let namaSpv = "";
let zonaA = "";
let zonaKosong = "";
const warga: Record<"rendah" | "aman" | "lain", string> = {
  rendah: "",
  aman: "",
  lain: "",
};

async function buatWarga(label: string, zonaId: string, saldoL: number) {
  const p = await prisma.pengguna.create({
    data: {
      nama: `Warga ${label}`,
      email: `bc_${label}_${unik}@contoh.test`,
      kataSandiHash: "hash",
      peran: Peran.WARGA,
      zonaId,
    },
  });
  const m = await prisma.meter.create({
    data: {
      id: `UJI-BC-${label}-${unik}`,
      node: `UJI.BC.${label}.${unik}`,
      serial: `UJI-BC-${label}-${unik}`,
      penggunaId: p.id,
      zonaId,
      saldoL,
      ambangPeringatanL: 5,
    },
  });
  return { pengguna: p, meter: m };
}

async function penerima(broadcastId: string): Promise<Set<string>> {
  const baris = await prisma.notifikasi.findMany({
    where: { broadcastId },
    select: { penggunaId: true },
  });
  return new Set(baris.map((b) => b.penggunaId));
}

async function kirim(isi: Record<string, unknown>) {
  return request(app)
    .post("/api/admin/broadcast")
    .set("Authorization", `Bearer ${tokenSpv}`)
    .send({ judul: "Uji sasaran", pesan: "Pesan uji sasaran broadcast.", kanal: { push: true }, ...isi });
}

beforeAll(async () => {
  namaSpv = `Supervisor Sasaran ${unik}`;
  const spv = await prisma.pengguna.create({
    data: {
      nama: namaSpv,
      email: `bc_spv_${unik}@jernih.id`,
      kataSandiHash: "hash",
      peran: Peran.SUPERVISOR,
    },
  });
  tokenSpv = await buatAkses({ sub: spv.id, peran: Peran.SUPERVISOR });

  zonaA = (await prisma.zona.create({ data: { nama: `Zona Uji A ${unik}` } })).id;
  const zonaB = (await prisma.zona.create({ data: { nama: `Zona Uji B ${unik}` } })).id;
  zonaKosong = (await prisma.zona.create({ data: { nama: `Zona Kosong ${unik}` } })).id;

  const rendah = await buatWarga("rendah", zonaA, 3);
  const aman = await buatWarga("aman", zonaB, 500);
  const lain = await buatWarga("lain", zonaB, 800);
  warga.rendah = rendah.pengguna.id;
  warga.aman = aman.pengguna.id;
  warga.lain = lain.pengguna.id;

});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/admin/broadcast — penerima menurut target", () => {
  it("SALDO_RENDAH hanya mengenai warga dengan meter di bawah ambang alarm", async () => {
    const res = await kirim({ target: "SALDO_RENDAH" });
    expect(res.status).toBe(201);

    const siapa = await penerima(res.body.broadcastId);
    expect(siapa.has(warga.rendah)).toBe(true);
    expect(siapa.has(warga.aman)).toBe(false);
    expect(siapa.has(warga.lain)).toBe(false);
  });

  it("TUNGGAKAN ditolak: produk prabayar tidak punya tunggakan", async () => {
    const res = await kirim({ target: "TUNGGAKAN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDASI_GAGAL");
  });

  it("ZONA hanya mengenai warga di zona itu, dan menolak tanpa zona", async () => {
    const res = await kirim({ target: "ZONA", zona: zonaA });
    expect(res.status).toBe(201);
    const siapa = await penerima(res.body.broadcastId);
    expect([...siapa]).toEqual([warga.rendah]);

    const tanpaZona = await kirim({ target: "ZONA" });
    expect(tanpaZona.status).toBe(400);
    expect(tanpaZona.body.error.code).toBe("VALIDASI_GAGAL");
  });

  it("menolak broadcast yang tidak punya penerima", async () => {
    const res = await kirim({ target: "ZONA", zona: zonaKosong });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BROADCAST_TANPA_PENERIMA");
  });

  it("menolak target yang tidak dikenal", async () => {
    const res = await kirim({ target: "SEMBARANG" });
    expect(res.status).toBe(400);
  });

  it("mencatat NAMA petugas di jejak audit, bukan id-nya", async () => {
    const res = await kirim({ target: "ZONA", zona: zonaA });
    expect(res.status).toBe(201);

    const jejak = await prisma.auditLog.findFirst({
      where: { aksi: "KIRIM_BROADCAST" },
      orderBy: { ts: "desc" },
    });
    expect(jejak?.aktorNama).toBe(namaSpv);
  });

  it("GET mengirim daftar zona untuk formulir", async () => {
    const res = await request(app)
      .get("/api/admin/broadcast")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(res.status).toBe(200);
    const ids = (res.body.zona as { id: string }[]).map((z) => z.id);
    expect(ids).toContain(zonaA);
  });
});

describe("PATCH /api/notifikasi/baca-semua", () => {
  it("menandai semuanya dan menaikkan `dibuka` satu kali per broadcast", async () => {
    const res = await kirim({ target: "ZONA", zona: zonaA });
    const broadcastId = res.body.broadcastId as string;
    const tokenWarga = await buatAkses({ sub: warga.rendah, peran: Peran.WARGA });

    const pertama = await request(app)
      .patch("/api/notifikasi/baca-semua")
      .set("Authorization", `Bearer ${tokenWarga}`);
    expect(pertama.status).toBe(200);
    expect(pertama.body.ditandai).toBeGreaterThan(0);

    const sisa = await prisma.notifikasi.count({
      where: { penggunaId: warga.rendah, dibacaPada: null },
    });
    expect(sisa).toBe(0);
    expect((await prisma.broadcast.findUnique({ where: { id: broadcastId } }))?.dibuka).toBe(1);

    // Kedua kali tidak boleh menaikkan apa pun.
    const kedua = await request(app)
      .patch("/api/notifikasi/baca-semua")
      .set("Authorization", `Bearer ${tokenWarga}`);
    expect(kedua.body.ditandai).toBe(0);
    expect((await prisma.broadcast.findUnique({ where: { id: broadcastId } }))?.dibuka).toBe(1);
  });
});
