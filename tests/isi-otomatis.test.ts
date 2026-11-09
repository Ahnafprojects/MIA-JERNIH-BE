/**
 * Isi ulang otomatis saat saldo meter menipis.
 *
 * Yang dikunci di sini adalah aturan yang kalau rusak akan merugikan warga
 * dengan uang sungguhan: membeli saat tidak seharusnya, atau membeli
 * berkali-kali untuk satu keadaan yang sama.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { buatAkses } from "../src/lib/auth.js";
import { periksaIsiOtomatis } from "../src/lib/isi-otomatis.js";

let urut = 0;

async function buatWargaDenganMeter(opsi: {
  saldoL: number;
  aktif?: boolean;
  ambangL?: number;
  volumeL?: number;
}) {
  urut += 1;
  const unik = `${Date.now()}_${urut}`;

  const warga = await prisma.pengguna.create({
    data: {
      nama: "Warga Isi Otomatis",
      email: `isiotomatis_${unik}@test.id`,
      kataSandiHash: "hash123",
      peran: "WARGA",
    },
  });

  const meterId = `MTR_AUTO_${unik}`;
  await prisma.meter.create({
    data: {
      id: meterId,
      node: `node_${meterId}`,
      serial: `ser_${meterId}`,
      penggunaId: warga.id,
      saldoL: opsi.saldoL,
      isiOtomatisAktif: opsi.aktif ?? true,
      isiOtomatisAmbangL: opsi.ambangL ?? 100,
      isiOtomatisVolumeL: opsi.volumeL ?? 1000,
    },
  });

  return { warga, meterId };
}

describe("Isi otomatis", () => {
  const app = buatApp();

  it("INTI: saldo di bawah ambang menerbitkan satu pembelian lunas berikut tokennya", async () => {
    const { warga, meterId } = await buatWargaDenganMeter({ saldoL: 40 });

    const hasil = await periksaIsiOtomatis(meterId);
    expect(hasil.dibeli).toBe(true);
    expect(hasil.invoiceId).toBeTruthy();

    const tx = await prisma.transaksi.findUnique({
      where: { id: hasil.invoiceId! },
      include: { token: true },
    });
    expect(tx?.status).toBe("LUNAS");
    expect(Number(tx?.volumeL)).toBe(1000);
    expect(tx?.penggunaId).toBe(warga.id);
    // Token terbit — ini yang sebenarnya menyelamatkan pasokan air.
    expect(tx?.token).toHaveLength(1);

    /*
     * Saldo METER tidak boleh ikut naik. Saldo hanya berubah saat meter
     * benar-benar menerapkan tokennya; menaikkannya di sini membuat token
     * yang sama bisa terpakai dua kali.
     */
    const meter = await prisma.meter.findUnique({ where: { id: meterId } });
    expect(Number(meter?.saldoL)).toBe(40);
  });

  it("saldo masih di atas ambang TIDAK membeli apa pun", async () => {
    const { meterId } = await buatWargaDenganMeter({ saldoL: 500 });

    const hasil = await periksaIsiOtomatis(meterId);
    expect(hasil.dibeli).toBe(false);
    expect(hasil.alasan).toBe("SALDO_CUKUP");

    const jumlah = await prisma.transaksi.count({ where: { meterId } });
    expect(jumlah).toBe(0);
  });

  it("fitur nonaktif TIDAK membeli walau saldo nyaris habis", async () => {
    const { meterId } = await buatWargaDenganMeter({ saldoL: 1, aktif: false });

    const hasil = await periksaIsiOtomatis(meterId);
    expect(hasil.dibeli).toBe(false);
    expect(hasil.alasan).toBe("NONAKTIF");
    expect(await prisma.transaksi.count({ where: { meterId } })).toBe(0);
  });

  it("JEDA: pemeriksaan beruntun hanya menghasilkan SATU pembelian", async () => {
    const { meterId } = await buatWargaDenganMeter({ saldoL: 10 });

    /*
     * Keadaan paling berbahaya di fitur ini: saldo meter TIDAK naik setelah
     * pembelian (tokennya belum ditukarkan), jadi pemeriksaan berikutnya
     * melihat keadaan yang sama persis. Tanpa jeda, portal yang memanggil
     * `/live` tiap lima detik akan menerbitkan tagihan tanpa henti.
     */
    await periksaIsiOtomatis(meterId);
    await periksaIsiOtomatis(meterId);
    await periksaIsiOtomatis(meterId);

    expect(await prisma.transaksi.count({ where: { meterId } })).toBe(1);
  });

  it("pemeriksaan serentak tidak menembus jeda", async () => {
    const { meterId } = await buatWargaDenganMeter({ saldoL: 10 });

    await Promise.all([
      periksaIsiOtomatis(meterId),
      periksaIsiOtomatis(meterId),
      periksaIsiOtomatis(meterId),
    ]);

    expect(await prisma.transaksi.count({ where: { meterId } })).toBe(1);
  });

  it("PUT lalu GET menyimpan dan mengembalikan pengaturannya", async () => {
    const { warga, meterId } = await buatWargaDenganMeter({
      saldoL: 900,
      aktif: false,
    });
    const jwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    const put = await request(app)
      .put("/api/isi-otomatis")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ meterId, aktif: true, ambangL: 250, volumeL: 2000, metode: "VA" });

    expect(put.status).toBe(200);
    expect(put.body.aktif).toBe(true);
    expect(put.body.ambangL).toBe(250);
    expect(put.body.volumeL).toBe(2000);
    expect(put.body.metode).toBe("VA");

    const get = await request(app)
      .get(`/api/isi-otomatis?meterId=${meterId}`)
      .set("Authorization", `Bearer ${jwt}`);

    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ aktif: true, ambangL: 250, volumeL: 2000 });
  });

  it("warga lain tidak bisa mengubah pengaturan meter yang bukan miliknya", async () => {
    const { meterId } = await buatWargaDenganMeter({ saldoL: 900 });

    urut += 1;
    const penyusup = await prisma.pengguna.create({
      data: {
        nama: "Bukan Pemilik",
        email: `penyusup_${Date.now()}_${urut}@test.id`,
        kataSandiHash: "hash123",
        peran: "WARGA",
      },
    });
    const jwt = await buatAkses({ sub: penyusup.id, peran: "WARGA" });

    const res = await request(app)
      .put("/api/isi-otomatis")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ meterId, aktif: true });

    expect(res.status).toBe(403);
  });

  it("menolak ambang di wilayah alarm firmware", async () => {
    const { warga, meterId } = await buatWargaDenganMeter({ saldoL: 900 });
    const jwt = await buatAkses({ sub: warga.id, peran: "WARGA" });

    /*
     * Ambang 5 L sama dengan ambang alarm firmware. Pembelian yang terbit
     * di titik itu tidak akan pernah sempat ditukarkan sebelum relay
     * menutup — fiturnya menyala tapi tidak menyelamatkan apa pun.
     */
    const res = await request(app)
      .put("/api/isi-otomatis")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ meterId, aktif: true, ambangL: 5 });

    expect(res.status).toBe(400);
  });
});
