/**
 * Akun peragaan dan bentuk deret tren Rapor Kinerja.
 *
 * Keduanya pernah membuat halaman tidak bisa dipakai sama sekali di
 * produksi, dan keduanya lolos build serta typecheck. Yang diuji di sini
 * bukan kerapian kode, melainkan apakah seseorang benar-benar bisa masuk dan
 * apakah grafiknya punya cukup titik untuk digambar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import argon2 from "argon2";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const app = buatApp();

/** Dua user-agent berbeda mewakili dua perangkat berbeda. */
const PERANGKAT_A = "Mozilla/5.0 (Macintosh) PerangkatUjiA";
const PERANGKAT_B = "Mozilla/5.0 (Windows NT 10.0) PerangkatUjiB";

const sandi = "rahasia-uji-123";
let emailDemo = "";
let emailBiasa = "";
let emailOperator = "";

beforeAll(() => {
  const cap = Date.now();

  emailDemo = `demo_${cap}@jernih.id`;
  emailBiasa = `biasa_${cap}@contoh.test`;
  emailOperator = `op_${cap}@jernih.id`;
});

/*
 * Akun dipastikan ada SETIAP KALI dipakai, bukan sekali di `beforeAll`.
 *
 * `tests/seed.test.ts` memanggil `jalankanSeed()`, yang mengosongkan seluruh
 * tabel. Vitest menjalankan berkas tes secara paralel, jadi pengosongan itu
 * bisa jatuh di tengah berkas ini dan menghapus akun yang sudah disiapkan.
 * Gejalanya login membalas 401 pada tes yang sebelumnya lolos, dan hanya
 * muncul saat seluruh suite dijalankan bersamaan.
 */
async function pastikanAkun(
  email: string,
  akunDemo: boolean,
  peran: "WARGA" | "OPERATOR",
): Promise<void> {
  const hash = await argon2.hash(sandi, { type: argon2.argon2id });
  await prisma.pengguna.upsert({
    where: { email },
    update: { kataSandiHash: hash, akunDemo, peran, aktif: true },
    create: {
      nama: "Penguji",
      email,
      kataSandiHash: hash,
      emailTerverifikasiPada: new Date(),
      akunDemo,
      peran,
    },
  });
}

const masuk = async (email: string, perangkat: string) => {
  const peran = email.startsWith("op_") ? "OPERATOR" : "WARGA";
  await pastikanAkun(email, !email.includes("@contoh.test"), peran);
  return request(app)
    .post("/api/auth/masuk")
    .set("User-Agent", perangkat)
    .send({ email, kataSandi: sandi });
};

describe("Masuk dari perangkat baru", () => {
  it("akun peragaan langsung mendapat sesi, bukan diminta kode email", async () => {
    // Masuk pertama membuat sesi, sehingga perangkat kedua di bawah ini
    // benar-benar dianggap perangkat baru.
    const pertama = await masuk(emailDemo, PERANGKAT_A);
    expect(pertama.status).toBe(200);
    expect(pertama.body.accessToken).toBeTruthy();

    const kedua = await masuk(emailDemo, PERANGKAT_B);
    expect(kedua.status).toBe(200);

    /*
     * Inilah regresi yang dijaga. Saat akun demo ikut diminta kode, kodenya
     * dikirim ke alamat @jernih.id yang tidak punya kotak surat, dan seluruh
     * konsol petugas menjadi tidak bisa dibuka oleh siapa pun di produksi.
     */
    expect(kedua.body.step).toBeUndefined();
    expect(kedua.body.accessToken).toBeTruthy();
  });

  it("akun biasa tetap diminta kode saat perangkatnya baru", async () => {
    const pertama = await masuk(emailBiasa, PERANGKAT_A);
    expect(pertama.status).toBe(200);
    expect(pertama.body.accessToken).toBeTruthy();

    const kedua = await masuk(emailBiasa, PERANGKAT_B);
    expect(kedua.status).toBe(200);
    // Kelonggaran untuk akun demo tidak boleh bocor ke akun sungguhan.
    expect(kedua.body.step).toBe("KODE_EMAIL");
    expect(kedua.body.accessToken).toBeUndefined();
  });

  it("akun peragaan tetap menolak kata sandi yang salah", async () => {
    const res = await request(app)
      .post("/api/auth/masuk")
      .set("User-Agent", PERANGKAT_A)
      .send({ email: emailDemo, kataSandi: "bukan-sandinya" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("KREDENSIAL_SALAH");
  });
});

describe("GET /api/admin/pelanggan — bentuk yang dibaca konsol", () => {
  let tokenOp = "";

  beforeAll(async () => {
    const res = await masuk(emailOperator, PERANGKAT_A);
    tokenOp = res.body.accessToken ?? "";
  });

  it("mengirim seluruh medan yang dipakai halaman, termasuk jumlahStatus", async () => {
    const res = await request(app)
      .get("/api/admin/pelanggan?halaman=1&per=25&urut=nama&arah=naik")
      .set("Authorization", `Bearer ${tokenOp}`);
    expect(res.status).toBe(200);

    /*
     * `jumlahStatus` yang hilang dulu membuat `jumlahStatus[s]` melempar saat
     * render, dan batas galat Next mengganti SELURUH halaman daftar pelanggan
     * dengan "This page couldn't load".
     */
    for (const medan of [
      "baris",
      "total",
      "halaman",
      "perHalaman",
      "halamanTerakhir",
      "jumlahSaring",
      "jumlahStatus",
      "zona",
    ]) {
      expect(res.body).toHaveProperty(medan);
    }

    expect(Array.isArray(res.body.baris)).toBe(true);
    expect(Object.keys(res.body.jumlahStatus).sort()).toEqual([
      "alarm",
      "insiden",
      "normal",
      "offline",
    ]);
    expect(Object.keys(res.body.jumlahSaring).sort()).toEqual([
      "aktif",
      "insiden",
      "nonaktif",
      "offline",
      "saldo-menipis",
    ]);
  });

  it("tiap baris membawa medan meter yang dibaca tabel", async () => {
    const res = await request(app)
      .get("/api/admin/pelanggan?halaman=1&per=5")
      .set("Authorization", `Bearer ${tokenOp}`);
    const b = res.body.baris[0];
    if (!b) return; // basis data uji boleh kosong
    for (const medan of [
      "id", "nama", "zonaId", "zona", "saldoL", "debitLpm",
      "relayOn", "online", "adaInsiden", "koordinat", "terakhirLapor", "status",
    ]) {
      expect(b).toHaveProperty(medan);
    }
    expect(["normal", "alarm", "insiden", "offline"]).toContain(b.status);
    expect(Array.isArray(b.koordinat)).toBe(true);
  });

  it("mengurutkan menurut parameter urut dan arah", async () => {
    const res = await request(app)
      .get("/api/admin/pelanggan?halaman=1&per=50&urut=saldo&arah=naik")
      .set("Authorization", `Bearer ${tokenOp}`);
    const saldo = res.body.baris.map((x: { saldoL: number }) => x.saldoL);
    const urut = [...saldo].sort((a: number, b: number) => a - b);
    expect(saldo).toEqual(urut);
  });
});

describe("GET /api/publik/kinerja — bentuk deret tren", () => {
  it("tiap rentang menghasilkan cukup titik untuk digambar sebagai garis", async () => {
    for (const rentang of [7, 30, 90]) {
      const res = await request(app).get(`/api/publik/kinerja?rentang=${rentang}`);
      expect(res.status).toBe(200);

      const titik = res.body.tren.series[0].points;
      const label = res.body.tren.labels;

      /*
       * Rentang 7 hari dulu menghasilkan `ceil(7/7) = 1` titik. Satu titik
       * bukan grafik: tidak ada garis yang bisa digambar dan pembaca tidak
       * bisa menyimpulkan arah apa pun.
       */
      expect(titik.length).toBeGreaterThanOrEqual(5);
      expect(label).toHaveLength(titik.length);
    }
  });

  it("label berupa tanggal, bukan hitungan pekan relatif", async () => {
    const res = await request(app).get("/api/publik/kinerja?rentang=7");
    // "3 pekan lalu" menjadi keliru begitu embernya selebar satu hari.
    for (const l of res.body.tren.labels) {
      expect(l).not.toMatch(/pekan/i);
      expect(l).toMatch(/^\d{1,2} \w{3}$/);
    }
  });

  it("nilainya persentase yang sah atau null, tidak pernah di luar 0–100", async () => {
    const res = await request(app).get("/api/publik/kinerja?rentang=90");
    for (const v of res.body.tren.series[0].points) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
