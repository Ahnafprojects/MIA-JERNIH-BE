import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { Peran } from "@prisma/client";

describe("Konsol Petugas: Dashboard, Pelanggan, Perangkat, Analitik & Pengaturan (Issue #8 & #9)", () => {
  const app = buatApp();

  it("dashboard: mengembalikan KPI array lengkap dengan key standar", async () => {
    const op = await prisma.pengguna.create({
      data: {
        nama: "Operator Dashboard",
        email: `op_dash_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.OPERATOR,
      },
    });

    const tokenOp = await buatAkses({ sub: op.id, peran: Peran.OPERATOR });

    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${tokenOp}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.kpi)).toBe(true);

    const keys = res.body.kpi.map((k: { key: string }) => k.key);
    expect(keys).toContain("pelangganTerhubung");
    expect(keys).toContain("meterTotal");
    expect(keys).toContain("meterOnline");
    expect(keys).toContain("meterOffline");
    expect(keys).toContain("saldoKritis");
    expect(keys).toContain("relayTertutup");
    expect(keys).toContain("insidenBaru");
    expect(keys).toContain("nrwRataPct");
  });

  it("teknisi ditolak saat mencoba endpoint khusus supervisor", async () => {
    const teknisi = await prisma.pengguna.create({
      data: {
        nama: "Teknisi Lapangan",
        email: `tek_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.TEKNISI,
      },
    });

    const tokenTek = await buatAkses({ sub: teknisi.id, peran: Peran.TEKNISI });

    // Coba ubah tarif
    const resTarif = await request(app)
      .patch("/api/admin/pengaturan/tarif")
      .set("Authorization", `Bearer ${tokenTek}`)
      .send({
        golonganId: "gol-1",
        tarifBaru: 15,
        alasan: "Naikkan tarif",
      });

    expect(resTarif.status).toBe(403);
    expect(resTarif.body.error.code).toBe("PERAN_TIDAK_CUKUP");
  });

  it("konfigurasi meter tercatat di AuditLog lengkap dengan alasan", async () => {
    const spv = await prisma.pengguna.create({
      data: {
        nama: "Supervisor Konfig",
        email: `spv_cfg_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.SUPERVISOR,
      },
    });

    const meterId = `MTR_CFG_${Date.now()}`;
    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
      },
    });

    const tokenSpv = await buatAkses({ sub: spv.id, peran: Peran.SUPERVISOR });
    const alasan = "Penyesuaian ambang meter industri";

    const res = await request(app)
      .post("/api/admin/konfigurasi-meter")
      .set("Authorization", `Bearer ${tokenSpv}`)
      .send({
        meterIds: [meterId],
        ambangKritisL: 3,
        kalibrasi: 7.0,
        alasan,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const log = await prisma.auditLog.findFirst({
      where: { aksi: "KONFIGURASI_METER", aktorId: spv.id },
      orderBy: { ts: "desc" },
    });

    expect(log).toBeDefined();
    expect(log?.detail).toContain(alasan);
  });

  it("analitik: series[].points.length === labels.length untuk semua rentang", async () => {
    const op = await prisma.pengguna.create({
      data: {
        nama: "Operator Analitik",
        email: `op_anl_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.OPERATOR,
      },
    });

    const tokenOp = await buatAkses({ sub: op.id, peran: Peran.OPERATOR });

    for (const r of [7, 30]) {
      const res = await request(app)
        .get(`/api/admin/analitik?rentang=${r}`)
        .set("Authorization", `Bearer ${tokenOp}`);

      expect(res.status).toBe(200);
      const { labels, series } = res.body;
      expect(Array.isArray(labels)).toBe(true);
      expect(Array.isArray(series)).toBe(true);

      for (const s of series) {
        expect(s.points.length).toBe(labels.length);
      }
    }
  });

  it("pengaturan tim memakai members, tarif memakai golongan, keamanan & notifikasi datar", async () => {
    const spv = await prisma.pengguna.create({
      data: {
        nama: "Supervisor Pengaturan",
        email: `spv_set_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.SUPERVISOR,
      },
    });

    const tokenSpv = await buatAkses({ sub: spv.id, peran: Peran.SUPERVISOR });

    // Tim
    const resTim = await request(app)
      .get("/api/admin/pengaturan/tim")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(resTim.status).toBe(200);
    expect(resTim.body).toHaveProperty("members");
    expect(resTim.body).not.toHaveProperty("rows");

    // Tarif
    const resTarif = await request(app)
      .get("/api/admin/pengaturan/tarif")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(resTarif.status).toBe(200);
    expect(resTarif.body).toHaveProperty("golongan");
    expect(resTarif.body).not.toHaveProperty("rows");

    // Keamanan
    const resKeamanan = await request(app)
      .get("/api/admin/pengaturan/keamanan")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(resKeamanan.status).toBe(200);
    expect(resKeamanan.body).not.toHaveProperty("settings");
    expect(resKeamanan.body).toHaveProperty("jwtAccessTtlMenit");

    // Notifikasi
    const resNotif = await request(app)
      .get("/api/admin/pengaturan/notifikasi")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(resNotif.status).toBe(200);
    expect(resNotif.body).not.toHaveProperty("settings");
    expect(resNotif.body).toHaveProperty("notifikasiTiketEmail");
  });

  it("broadcast: kanal datar dan dibuka tidak naik dua kali untuk pengguna yang sama", async () => {
    const spv = await prisma.pengguna.create({
      data: {
        nama: "Supervisor Broadcast",
        email: `spv_bc_${Date.now()}@jernih.id`,
        kataSandiHash: "hash123",
        peran: Peran.SUPERVISOR,
      },
    });

    const warga = await prisma.pengguna.create({
      data: {
        nama: "Warga Penerima",
        email: `warga_bc_${Date.now()}@test.id`,
        kataSandiHash: "hash123",
        peran: Peran.WARGA,
      },
    });

    const tokenSpv = await buatAkses({ sub: spv.id, peran: Peran.SUPERVISOR });
    const tokenWarga = await buatAkses({ sub: warga.id, peran: Peran.WARGA });

    // 1. Buat broadcast
    const resKirim = await request(app)
      .post("/api/admin/broadcast")
      .set("Authorization", `Bearer ${tokenSpv}`)
      .send({
        judul: "Pembersihan Pipa Induk",
        pesan: "Aliran air akan dijeda sementara",
        target: "SEMUA_WARGA",
        kanal: { push: true, email: false },
      });

    expect(resKirim.status).toBe(201);
    expect(resKirim.body.ok).toBe(true);
    const broadcastId = resKirim.body.broadcastId;

    // 2. Cek list broadcast (kanal datar)
    const resListBc = await request(app)
      .get("/api/admin/broadcast")
      .set("Authorization", `Bearer ${tokenSpv}`);
    expect(resListBc.status).toBe(200);
    const bc = resListBc.body.broadcast.find((b: { id: string }) => b.id === broadcastId);
    expect(bc).toBeDefined();
    expect(bc.kanalPush).toBe(true);
    expect(bc.kanalEmail).toBe(false);

    // 3. Warga membaca notifikasi broadcast
    const resNotif = await request(app)
      .get("/api/notifikasi")
      .set("Authorization", `Bearer ${tokenWarga}`);
    expect(resNotif.status).toBe(200);

    const notifWarga = resNotif.body.notifikasi.find(
      (n: { judul: string }) => n.judul === "Pembersihan Pipa Induk",
    );
    expect(notifWarga).toBeDefined();

    // Tandai baca pertama kali
    await request(app)
      .patch(`/api/notifikasi/${notifWarga.id}/baca`)
      .set("Authorization", `Bearer ${tokenWarga}`);

    const bcSetelahBaca1 = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    expect(bcSetelahBaca1?.dibuka).toBe(1);

    // Tandai baca kedua kali (tidak boleh menaikkan dibuka)
    await request(app)
      .patch(`/api/notifikasi/${notifWarga.id}/baca`)
      .set("Authorization", `Bearer ${tokenWarga}`);

    const bcSetelahBaca2 = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    expect(bcSetelahBaca2?.dibuka).toBe(1);
  });
});
