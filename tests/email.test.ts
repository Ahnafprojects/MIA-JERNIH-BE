import { describe, expect, it } from "vitest";
import {
  emailBroadcast,
  emailLupaSandi,
  emailMasukBaru,
  emailPembelianLunas,
  emailSaldoMenipis,
  emailTiketDiperbarui,
  emailVerifikasiDaftar,
  kirimEmail,
} from "../src/lib/email.js";

describe("Email Transaksional (Issue #11)", () => {
  it("MAIL_ENABLED=false tidak memanggil SMTP dan tidak melempar galat", async () => {
    const email = emailVerifikasiDaftar("warga@contoh.id", "123456");
    const hasil = await kirimEmail(email);
    expect(hasil).toBe(true);
  });

  it("7 jenis email menghasilkan subjek, teks, dan html berbasis tabel <= 600px", () => {
    const list = [
      emailVerifikasiDaftar("warga@contoh.id", "123456"),
      emailMasukBaru("warga@contoh.id", "654321"),
      emailLupaSandi("warga@contoh.id", "https://jernih.id/atur-ulang?t=abc"),
      emailPembelianLunas("warga@contoh.id", {
        invoiceId: "INV-001",
        meterId: "P001",
        volumeL: 5000,
        jumlahRp: 37500,
        kodeToken: "7786571139",
        waktu: new Date().toISOString(),
      }),
      emailSaldoMenipis("warga@contoh.id", "P001", 10, 50),
      emailTiketDiperbarui("warga@contoh.id", "LP-2026-10-0001", "BARU", "DIPROSES", "Petugas meluncur"),
      emailBroadcast("warga@contoh.id", "Pemadaman Air", "Pipa sedang diperbaiki"),
    ];

    expect(list).toHaveLength(7);
    for (const em of list) {
      expect(em.subjek).toBeTruthy();
      expect(em.teks).toBeTruthy();
      expect(em.html).toContain("<table");
      expect(em.html).toContain("max-width: 600px");
      // Memastikan hex styling digunakan
      expect(em.html).toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it("kode token hanya muncul pada email pembelian lunas", () => {
    const struk = emailPembelianLunas("warga@contoh.id", {
      invoiceId: "INV-001",
      meterId: "P001",
      volumeL: 5000,
      jumlahRp: 37500,
      kodeToken: "7786571139",
      waktu: new Date().toISOString(),
    });
    expect(struk.html).toContain("7786571139");
    expect(struk.teks).toContain("7786571139");

    const verif = emailVerifikasiDaftar("warga@contoh.id", "123456");
    expect(verif.html).not.toContain("Kode Token Air");
  });
});
