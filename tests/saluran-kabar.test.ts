/**
 * Pendaftaran saluran kabar warga: nomor WhatsApp dan tautan Telegram.
 *
 * Yang diuji di sini bukan kerapian kode melainkan dua hal yang kalau salah
 * langsung berakibat di dunia nyata:
 *
 * 1. Nomor yang sama, ditulis dengan cara berbeda, harus mendarat sebagai
 *    SATU nilai. Kalau tidak, satu orang tersimpan sebagai beberapa nomor dan
 *    setiap pemeriksaan yang membandingkannya tidak akan pernah cocok.
 * 2. Persetujuan tidak bisa menyala tanpa tindakan sadar. Pengirimnya nomor
 *    bisnis sungguhan; satu laporan spam dari orang yang tidak pernah meminta
 *    menghilangkan saluran itu untuk semua warga sekaligus.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import argon2 from "argon2";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const app = buatApp();
const PERANGKAT = "Mozilla/5.0 (Macintosh) PerangkatUjiKabar";
const sandi = "rahasia-uji-123";

let email = "";

beforeAll(() => {
  email = `kabar_${Date.now()}@contoh.test`;
});

/*
 * Akun dipastikan ada SETIAP KALI dipakai, bukan sekali di `beforeAll`.
 * `tests/seed.test.ts` mengosongkan seluruh tabel dan vitest menjalankan
 * berkas tes paralel, jadi pengosongan itu bisa jatuh di tengah berkas ini.
 */
async function masuk(): Promise<string> {
  const hash = await argon2.hash(sandi, { type: argon2.argon2id });
  await prisma.pengguna.upsert({
    where: { email },
    update: { kataSandiHash: hash, aktif: true, akunDemo: true },
    create: {
      nama: "Penguji Kabar",
      email,
      kataSandiHash: hash,
      emailTerverifikasiPada: new Date(),
      akunDemo: true,
      peran: "WARGA",
    },
  });

  const res = await request(app)
    .post("/api/auth/masuk")
    .set("User-Agent", PERANGKAT)
    .send({ email, kataSandi: sandi });

  return res.body.accessToken as string;
}

describe("GET /api/me/notifikasi", () => {
  it("menolak tanpa sesi", async () => {
    const res = await request(app).get("/api/me/notifikasi");
    expect(res.status).toBe(401);
  });

  it("mengembalikan keadaan kosong untuk akun baru", async () => {
    const token = await masuk();
    const res = await request(app)
      .get("/api/me/notifikasi")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.whatsapp).toEqual({ nomor: null, aktif: false });
    expect(res.body.telegram).toEqual({ tertaut: false });
  });

  it("tidak pernah membocorkan chatId Telegram ke klien", async () => {
    const token = await masuk();
    await prisma.pengguna.update({
      where: { email },
      data: { telegramChatId: "123456789" },
    });

    const res = await request(app)
      .get("/api/me/notifikasi")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.telegram.tertaut).toBe(true);
    /*
     * chatId adalah pengenal yang bisa dipakai bot mana pun yang
     * mengetahuinya untuk mengirimi orangnya pesan. Antarmuka tidak
     * membutuhkannya, jadi ia tidak boleh ikut keluar.
     */
    expect(JSON.stringify(res.body)).not.toContain("123456789");

    await prisma.pengguna.update({
      where: { email },
      data: { telegramChatId: null },
    });
  });
});

describe("PUT /api/me/notifikasi/whatsapp", () => {
  it("menolak tanpa persetujuan eksplisit", async () => {
    const token = await masuk();

    for (const badan of [
      { nomor: "081252961135", setuju: false },
      { nomor: "081252961135" },
    ]) {
      const res = await request(app)
        .put("/api/me/notifikasi/whatsapp")
        .set("Authorization", `Bearer ${token}`)
        .send(badan);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Persetujuan");
    }

    // Tidak satu pun dari penolakan di atas boleh meninggalkan nomor.
    const sesudah = await prisma.pengguna.findUnique({
      where: { email },
      select: { waNomor: true, waOptIn: true },
    });
    expect(sesudah?.waNomor).toBeNull();
    expect(sesudah?.waOptIn).toBe(false);
  });

  it("menolak nomor yang tidak terbaca, dengan pesan yang menuntun", async () => {
    const token = await masuk();

    for (const nomor of ["12345", "abcdefghij", "+1 555 0100"]) {
      const res = await request(app)
        .put("/api/me/notifikasi/whatsapp")
        .set("Authorization", `Bearer ${token}`)
        .send({ nomor, setuju: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NOMOR_WA_TIDAK_SAH");
      // Pesannya harus memberi tahu BENTUK yang benar, bukan sekadar "tidak valid".
      expect(res.body.error.message).toContain("081234567890");
    }
  });

  it("menormalkan tiga cara penulisan menjadi satu nilai", async () => {
    const token = await masuk();
    const hasil: string[] = [];

    for (const nomor of [
      "081252961135",
      "+62 812-5296-1135",
      "6281252961135",
    ]) {
      const res = await request(app)
        .put("/api/me/notifikasi/whatsapp")
        .set("Authorization", `Bearer ${token}`)
        .send({ nomor, setuju: true });

      expect(res.status).toBe(200);
      hasil.push(res.body.whatsapp.nomor as string);
    }

    expect(new Set(hasil).size).toBe(1);
    expect(hasil[0]).toBe("6281252961135");
  });
});

describe("DELETE /api/me/notifikasi/whatsapp", () => {
  it("menghapus nomornya, bukan hanya mematikan benderanya", async () => {
    const token = await masuk();

    await request(app)
      .put("/api/me/notifikasi/whatsapp")
      .set("Authorization", `Bearer ${token}`)
      .send({ nomor: "081252961135", setuju: true })
      .expect(200);

    const res = await request(app)
      .delete("/api/me/notifikasi/whatsapp")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.whatsapp).toEqual({ nomor: null, aktif: false });

    /*
     * Diperiksa langsung ke basis data, bukan cuma ke balasannya. Orang yang
     * mencabut persetujuan tidak sedang menitipkan nomornya untuk disimpan,
     * dan menahan nomor yang dasarnya sudah dicabut adalah menyimpan data
     * tanpa alasan.
     */
    const baris = await prisma.pengguna.findUnique({
      where: { email },
      select: { waNomor: true, waOptIn: true },
    });
    expect(baris?.waNomor).toBeNull();
    expect(baris?.waOptIn).toBe(false);
  });
});

describe("POST /api/me/notifikasi/telegram", () => {
  it("menolak kode yang bukan enam angka", async () => {
    const token = await masuk();

    for (const kode of ["12345", "1234567", "abcdef", ""]) {
      const res = await request(app)
        .post("/api/me/notifikasi/telegram")
        .set("Authorization", `Bearer ${token}`)
        .send({ kode });

      expect(res.status).toBe(400);
    }
  });

  it("melepas tautan Telegram", async () => {
    const token = await masuk();
    await prisma.pengguna.update({
      where: { email },
      data: { telegramChatId: "987654321" },
    });

    const res = await request(app)
      .delete("/api/me/notifikasi/telegram")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.telegram.tertaut).toBe(false);

    const baris = await prisma.pengguna.findUnique({
      where: { email },
      select: { telegramChatId: true },
    });
    expect(baris?.telegramChatId).toBeNull();
  });
});

describe("kepemilikan", () => {
  it("hanya mengubah akun pemilik sesi, bukan akun lain", async () => {
    const token = await masuk();

    /*
     * Tidak ada parameter id pengguna di endpoint mana pun; id selalu diambil
     * dari sesi. Uji ini mengirim id orang lain di badan permintaan untuk
     * memastikan ia memang DIABAIKAN, bukan dipakai.
     */
    const emailLain = `kabar_lain_${Date.now()}@contoh.test`;
    const hash = await argon2.hash(sandi, { type: argon2.argon2id });
    const lain = await prisma.pengguna.upsert({
      where: { email: emailLain },
      update: {},
      create: {
        nama: "Warga Lain",
        email: emailLain,
        kataSandiHash: hash,
        emailTerverifikasiPada: new Date(),
        akunDemo: true,
        peran: "WARGA",
      },
    });

    await request(app)
      .put("/api/me/notifikasi/whatsapp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nomor: "081252961135",
        setuju: true,
        penggunaId: lain.id,
        id: lain.id,
      })
      .expect(200);

    const korban = await prisma.pengguna.findUnique({
      where: { id: lain.id },
      select: { waNomor: true, waOptIn: true },
    });
    expect(korban?.waNomor).toBeNull();
    expect(korban?.waOptIn).toBe(false);

    await prisma.pengguna.delete({ where: { id: lain.id } });
  });
});
