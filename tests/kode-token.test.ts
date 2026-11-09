/**
 * Kode token yang bisa dibacakan ulang kepada pemiliknya.
 *
 * Yang dikunci di sini adalah batas-batas yang kalau rusak akan membocorkan
 * saldo air milik orang lain, atau sebaliknya mengunci air yang sudah
 * dibayar: siapa yang boleh membuka kode, sampai kapan, dan apakah kodenya
 * benar-benar hilang setelah dipakai.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";

import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses, hashKode } from "../src/lib/auth.js";
import { dekripsiKode, enkripsiKode } from "../src/lib/kode-token.js";

let urut = 0;

/**
 * Kode 10 digit yang tidak pernah bentrok antar-jalan.
 *
 * `kodeHash` bertanda `@unique` di skema, dan basis data uji TIDAK dihapus
 * antar-jalan — jadi kode tetap seperti "7693600901" lolos sekali lalu
 * menggagalkan seluruh berkas pada jalan kedua dengan galat yang sama
 * sekali tidak menyinggung keunikan.
 */
function kodeUnik(): string {
  urut += 1;
  /* Waktu + urutan SAJA masih bisa bentrok: dua jalan yang dimulai pada
     detik yang sama dengan urutan yang sama menghasilkan kode identik, dan
     gejalanya galat keunikan yang tampak acak. Bagian acak menghilangkannya. */
  const acak = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  return String(Date.now()).slice(-4) + String(urut % 100).padStart(2, "0") + acak;
}

async function buatWarga() {
  urut += 1;
  const unik = `${Date.now()}_${urut}`;
  return prisma.pengguna.create({
    data: {
      nama: "Warga Kode Token",
      email: `kodetoken_${unik}@test.id`,
      kataSandiHash: "hash123",
      peran: "WARGA",
    },
  });
}

async function buatToken(opsi: {
  pemilikId: string | null;
  kode: string;
  status?: "AKTIF" | "TERPAKAI" | "KEDALUWARSA" | "DIBATALKAN";
  kedaluwarsaPada?: Date;
  tanpaKodeTersandi?: boolean;
}) {
  return prisma.token.create({
    data: {
      kodeHash: hashKode(opsi.kode),
      kodeAwalan: opsi.kode.slice(0, 5),
      kodeTersandi: opsi.tanpaKodeTersandi ? null : enkripsiKode(opsi.kode),
      nilaiL: 1000,
      status: opsi.status ?? "AKTIF",
      sumber: "PEMBELIAN",
      pemilikId: opsi.pemilikId,
      kedaluwarsaPada:
        opsi.kedaluwarsaPada ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });
}

describe("Enkripsi kode token", () => {

  it("kode kembali utuh setelah dienkripsi lalu didekripsi", () => {
    const kode = "7693600901";
    expect(dekripsiKode(enkripsiKode(kode))).toBe(kode);
  });

  it("dua enkripsi kode yang SAMA menghasilkan ciphertext berbeda", () => {
    /* IV acak per kode. Kalau ini gagal, dua warga yang kebetulan mendapat
       kode sama bisa saling dikenali dari isi basis datanya. */
    expect(enkripsiKode("1234567890")).not.toBe(enkripsiKode("1234567890"));
  });

  it("ciphertext yang diubah GAGAL didekripsi, bukan menghasilkan sampah", () => {
    const sandi = enkripsiKode("1234567890");
    const [iv, isi, tag] = sandi.split(".");
    /*
     * Huruf yang diganti ada DI TENGAH badan ciphertext, bukan di ujungnya.
     *
     * Versi pertama tes ini mengganti karakter TERAKHIR, dan tesnya gagal —
     * bukan karena enkripsinya bocor, melainkan karena mutasinya tidak
     * mengubah apa pun. Karakter base64 terakhir hanya membawa sebagian bit
     * berarti; sisanya bit isian yang diabaikan saat dekode. Jadi `A` → `B`
     * di posisi itu menghasilkan deretan byte yang IDENTIK, dan wajar saja
     * tetap terdekripsi dengan benar.
     *
     * Dibuktikan: `Buffer.from(…,'base64url')` dari kedua versi sama persis
     * pada mutasi ujung, dan berbeda pada mutasi tengah.
     *
     * Tes yang gagal karena alasan yang SALAH lebih berbahaya daripada tes
     * yang tidak ada — ia mengundang orang memperbaiki kode yang benar.
     */
    const ganti = (s: string, i: number) =>
      `${s.slice(0, i)}${s[i] === "A" ? "B" : "A"}${s.slice(i + 1)}`;

    expect(dekripsiKode(`${iv}.${ganti(isi!, 3)}.${tag}`)).toBeNull();

    /* Tag dan IV juga harus menolak, masing-masing lewat jalurnya sendiri. */
    expect(dekripsiKode(`${iv}.${isi}.${ganti(tag!, 3)}`)).toBeNull();
    expect(dekripsiKode(`${ganti(iv!, 3)}.${isi}.${tag}`)).toBeNull();
  });

  it("nilai kosong dan bentuk asing dijawab null, bukan melempar", () => {
    expect(dekripsiKode(null)).toBeNull();
    expect(dekripsiKode("")).toBeNull();
    expect(dekripsiKode("bukan-format-yang-benar")).toBeNull();
  });
});

describe("GET /api/token/:id/kode", () => {
  const app = buatApp();


  it("INTI: pemilik mendapat kode UTUH selama token belum dipakai", async () => {
    const warga = await buatWarga();
    const kode = kodeUnik();
    const token = await buatToken({ pemilikId: warga.id, kode });

    const res = await request(app)
      .get(`/api/token/${token.id}/kode`)
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`);

    expect(res.status).toBe(200);
    expect(res.body.kode).toBe(kode);
  });

  it("orang lain TIDAK bisa membukanya, dan dijawab 404 bukan 403", async () => {
    const pemilik = await buatWarga();
    const penyusup = await buatWarga();
    const token = await buatToken({ pemilikId: pemilik.id, kode: kodeUnik() });

    const res = await request(app)
      .get(`/api/token/${token.id}/kode`)
      .set("Authorization", `Bearer ${await buatAkses({ sub: penyusup.id, peran: "WARGA" })}`);

    /* 404, bukan 403: membedakan "bukan milik Anda" dari "tidak ada"
       memberi tahu penyerang bahwa id yang ditebaknya benar. */
    expect(res.status).toBe(404);
    expect(res.body.kode).toBeUndefined();
  });

  it("tanpa masuk sama sekali ditolak", async () => {
    const warga = await buatWarga();
    const token = await buatToken({ pemilikId: warga.id, kode: kodeUnik() });

    const res = await request(app).get(`/api/token/${token.id}/kode`);
    expect(res.status).toBe(401);
  });

  it("token yang SUDAH DIPAKAI tidak mengembalikan kode", async () => {
    const warga = await buatWarga();
    const token = await buatToken({
      pemilikId: warga.id,
      kode: kodeUnik(),
      status: "TERPAKAI",
    });

    const res = await request(app)
      .get(`/api/token/${token.id}/kode`)
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`);

    expect(res.status).toBe(200);
    expect(res.body.kode).toBeNull();
    expect(res.body.alasan).toBe("TOKEN_TIDAK_AKTIF");
  });

  it("token KEDALUWARSA tidak mengembalikan kode walau statusnya masih AKTIF", async () => {
    const warga = await buatWarga();
    const token = await buatToken({
      pemilikId: warga.id,
      kode: kodeUnik(),
      kedaluwarsaPada: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .get(`/api/token/${token.id}/kode`)
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`);

    expect(res.status).toBe(200);
    expect(res.body.kode).toBeNull();
    /* Status yang DILAPORKAN harus kedaluwarsa, bukan AKTIF — kalau tidak,
       UI akan menulis "siap dipakai" untuk token yang sudah mati. */
    expect(res.body.status).toBe("KEDALUWARSA");
  });

  it("token lama yang hanya punya hash dijawab dengan alasan sendiri", async () => {
    const warga = await buatWarga();
    const token = await buatToken({
      pemilikId: warga.id,
      kode: kodeUnik(),
      tanpaKodeTersandi: true,
    });

    const res = await request(app)
      .get(`/api/token/${token.id}/kode`)
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`);

    expect(res.status).toBe(200);
    expect(res.body.kode).toBeNull();
    /* Dibedakan dari TOKEN_TIDAK_AKTIF: tokennya masih bisa dipakai, hanya
       kodenya yang tidak pernah tersimpan. UI harus mengarahkan warga ke
       email struknya, bukan bilang tokennya sudah terpakai. */
    expect(res.body.alasan).toBe("KODE_TIDAK_TERSIMPAN");
  });

  it("id yang tidak ada dijawab 404", async () => {
    const warga = await buatWarga();
    const res = await request(app)
      .get("/api/token/tidak-ada-sama-sekali/kode")
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`);

    expect(res.status).toBe(404);
  });
});

describe("Kode dibuang setelah penukaran", () => {
  const app = buatApp();


  it("INTI: `kodeTersandi` benar-benar kosong di basis data setelah ditukarkan", async () => {
    const warga = await buatWarga();
    urut += 1;
    const meterId = `MTR_KODE_${Date.now()}_${urut}`;

    await prisma.meter.create({
      data: {
        id: meterId,
        node: `node_${meterId}`,
        serial: `ser_${meterId}`,
        penggunaId: warga.id,
        saldoL: 0,
      },
    });

    const kode = kodeUnik();
    const token = await prisma.token.create({
      data: {
        kodeHash: hashKode(kode),
        kodeAwalan: kode.slice(0, 5),
        kodeTersandi: enkripsiKode(kode),
        nilaiL: 1000,
        status: "AKTIF",
        sumber: "PEMBELIAN",
        pemilikId: warga.id,
        meterId,
        kedaluwarsaPada: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });

    const tukar = await request(app)
      .post("/api/token/tukar")
      .set("Authorization", `Bearer ${await buatAkses({ sub: warga.id, peran: "WARGA" })}`)
      .send({ kode, meterId });

    expect(tukar.status).toBe(200);

    const sesudah = await prisma.token.findUnique({
      where: { id: token.id },
      select: { status: true, kodeTersandi: true, kodeHash: true },
    });

    expect(sesudah?.status).toBe("TERPAKAI");
    /* Inti pengujiannya: kode yang sudah terpakai tidak boleh tersisa. */
    expect(sesudah?.kodeTersandi).toBeNull();
    /* Hash TETAP ADA — ia yang mencegah kode yang sama terbit dua kali, dan
       yang membuat penukaran ulang ditolak dengan alasan yang benar. */
    expect(sesudah?.kodeHash).toBeTruthy();
  });
});
