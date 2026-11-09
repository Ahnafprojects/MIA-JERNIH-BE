import { afterAll, beforeEach, describe, expect, it } from "vitest";
import argon2 from "argon2";

import { prisma } from "../src/lib/prisma.js";
import { periksaSaldoMenipis } from "../src/lib/saldo-menipis.js";

/**
 * Uji penjaga harian peringatan saldo menipis.
 *
 * Yang diuji di sini BUKAN teks pesannya — itu sudah diuji terpisah sebagai
 * fungsi murni. Yang diuji adalah hal yang hanya bisa dibuktikan dengan
 * basis data sungguhan: bahwa pemanggilan kedua pada hari yang sama TIDAK
 * mengirim lagi.
 *
 * Kenapa itu yang paling penting: `GET /api/meter/:id/live` dipanggil portal
 * tiap LIMA DETIK selama halaman beranda terbuka. Penjaga yang bocor berarti
 * ratusan pesan ke satu warga dalam setengah jam, dan nomor pengirimnya
 * nomor bisnis sungguhan — dilaporkan sebagai spam berarti nomor itu
 * diblokir WhatsApp.
 */

const SANDI = "uji-saldo-menipis-123";

async function buatWarga(surel: string, ambangL: number) {
  const hash = await argon2.hash(SANDI, { type: argon2.argon2id });
  return prisma.pengguna.create({
    data: {
      nama: "Penguji Saldo",
      email: surel,
      kataSandiHash: hash,
      emailTerverifikasiPada: new Date(),
      peran: "WARGA",
      ambangPeringatanL: ambangL,
      // Sengaja TANPA waOptIn: penjaga harian harus bekerja terlepas dari
      // apakah ada saluran yang disetujui. Baris Notifikasi tetap ditulis.
    },
  });
}

async function buatMeter(penggunaId: string | null, saldoL: number) {
  /*
   * `id` dan `node` WAJIB diisi sendiri: keduanya tidak punya `@default` di
   * skema, karena `id` meter adalah kode fisik seperti `P001` dan `node`
   * adalah identitas MQTT-nya. Melewatkannya menghasilkan
   * PrismaClientValidationError yang pesannya tidak menyebut kolom mana.
   */
  const unik = Math.floor(Math.random() * 1e9);
  return prisma.meter.create({
    data: {
      id: `UJI-P${unik}`,
      node: `UJI.NODE.${unik}`,
      serial: `UJI-${unik}`,
      penggunaId,
      saldoL,
    },
  });
}

const bersihkan = async (surel: string) => {
  const p = await prisma.pengguna.findUnique({ where: { email: surel } });
  if (!p) return;
  await prisma.notifikasi.deleteMany({ where: { penggunaId: p.id } });
  await prisma.meter.deleteMany({ where: { penggunaId: p.id } });
  await prisma.pengguna.delete({ where: { id: p.id } });
};

const SUREL = "penguji_saldo@contoh.test";

beforeEach(async () => {
  await bersihkan(SUREL);
});

afterAll(async () => {
  await bersihkan(SUREL);
  await prisma.$disconnect();
});

describe("periksaSaldoMenipis", () => {
  it("diam saat saldo masih di atas ambang", async () => {
    const warga = await buatWarga(SUREL, 100);
    const meter = await buatMeter(warga.id, 250);

    await expect(periksaSaldoMenipis(meter.id)).resolves.toBe("SALDO_AMAN");

    const jumlah = await prisma.notifikasi.count({
      where: { penggunaId: warga.id, jenis: "SALDO" },
    });
    expect(jumlah).toBe(0);
  });

  it("memperingatkan sekali saat saldo di bawah ambang", async () => {
    const warga = await buatWarga(SUREL, 100);
    const meter = await buatMeter(warga.id, 40);

    await expect(periksaSaldoMenipis(meter.id)).resolves.toBe("DIPERINGATKAN");

    const baris = await prisma.notifikasi.findMany({
      where: { penggunaId: warga.id, jenis: "SALDO" },
    });
    expect(baris).toHaveLength(1);
    expect(baris[0]?.judul).toBe("Saldo air menipis");
    expect(baris[0]?.tautan).toBe("/beli");
  });

  it("TIDAK memperingatkan dua kali pada hari yang sama", async () => {
    const warga = await buatWarga(SUREL, 100);
    const meter = await buatMeter(warga.id, 40);

    await expect(periksaSaldoMenipis(meter.id)).resolves.toBe("DIPERINGATKAN");

    // Tiga pemanggilan berikutnya meniru portal yang memanggil tiap lima
    // detik. Semuanya harus tertahan.
    for (let i = 0; i < 3; i++) {
      await expect(periksaSaldoMenipis(meter.id)).resolves.toBe(
        "SUDAH_DIPERINGATKAN",
      );
    }

    const jumlah = await prisma.notifikasi.count({
      where: { penggunaId: warga.id, jenis: "SALDO" },
    });
    expect(jumlah).toBe(1);
  });

  it("memperingatkan lagi kalau peringatan terakhir dari kemarin", async () => {
    const warga = await buatWarga(SUREL, 100);
    const meter = await buatMeter(warga.id, 40);

    await periksaSaldoMenipis(meter.id);

    /*
     * Barisnya dimundurkan 30 jam, bukan 24. Dengan tepat 24 jam, pengujian
     * ini akan lolos bahkan bila penjaganya salah memakai "24 jam terakhir"
     * alih-alih "sejak awal hari". Tiga puluh jam memastikan barisnya jatuh
     * di hari kalender sebelumnya berapa pun jam uji ini dijalankan.
     */
    await prisma.notifikasi.updateMany({
      where: { penggunaId: warga.id, jenis: "SALDO" },
      data: { dibuatPada: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });

    await expect(periksaSaldoMenipis(meter.id)).resolves.toBe("DIPERINGATKAN");

    const jumlah = await prisma.notifikasi.count({
      where: { penggunaId: warga.id, jenis: "SALDO" },
    });
    expect(jumlah).toBe(2);
  });

  it("melewati meter tanpa pemilik", async () => {
    const meter = await buatMeter(null, 10);
    await expect(periksaSaldoMenipis(meter.id)).resolves.toBe("TANPA_PEMILIK");
    await prisma.meter.delete({ where: { id: meter.id } });
  });

  it("melewati meter yang tidak ada", async () => {
    await expect(periksaSaldoMenipis("meter-yang-tidak-ada")).resolves.toBe(
      "TIDAK_DITEMUKAN",
    );
  });
});
