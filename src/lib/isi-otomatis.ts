/**
 * Isi ulang otomatis saat saldo meter menipis.
 *
 * ── Kenapa ada ────────────────────────────────────────────────────────
 *
 * Air prabayar punya satu kegagalan yang selalu sama: warga lupa membeli,
 * saldo habis, relay menutup, dan air berhenti di tengah kegiatan. Alarm
 * firmware memang berbunyi lebih dulu, tetapi ambangnya ≤5 L — pada saat
 * itu membeli sudah terlambat, karena token masih harus diterbitkan,
 * sampai ke warga, lalu ditukarkan ke meter.
 *
 * Modul ini memindahkan pembeliannya jauh lebih awal, ke ambang yang
 * ditentukan warga sendiri (bawaan 100 L).
 *
 * ── Kapan diperiksa ───────────────────────────────────────────────────
 *
 * Backend ini TIDAK punya jalur masuk telemetri: tidak ada endpoint yang
 * menerima laporan dari ESP32, dan `saldoL` hanya berubah saat token
 * ditukarkan. Artinya tidak ada satu pun momen "saldo baru saja turun"
 * yang bisa dipakai sebagai pemicu.
 *
 * Yang tersedia adalah saat saldo DIBACA — `GET /api/meter/:id/live`, yang
 * dipanggil portal tiap lima detik selama halaman beranda terbuka.
 * Pemeriksaannya ditempelkan di situ, dengan dua pengaman karena memicu
 * pembelian dari sebuah GET jelas bukan hal yang boleh dilakukan ceroboh:
 *
 *   1. Jeda tersimpan di basis data (`isiOtomatisTerakhir`), bukan di
 *      memori proses. Memori hilang saat server dimulai ulang, dan
 *      penyetelan ulang berarti pembelian kedua.
 *   2. Kuncian per meter di dalam proses, supaya dua permintaan yang tiba
 *      bersamaan tidak lolos keduanya sebelum yang pertama sempat menulis
 *      penandanya.
 *
 * Saat jalur telemetri sungguhan nanti ada, `periksaIsiOtomatis` tinggal
 * dipanggil dari sana dan tempelan di jalur baca bisa dilepas.
 */
import pkg from "@prisma/client";
const { JenisTransaksi, StatusTransaksi } = pkg;
import { prisma } from "./prisma.js";
import { log } from "./log.js";
import { selesaikanPembayaran } from "../rute/bayar.js";

/**
 * Jarak minimum antar pembelian otomatis untuk satu meter.
 *
 * Enam jam, bukan beberapa menit. Saldo meter TIDAK langsung naik setelah
 * pembelian otomatis: tokennya masih menunggu ditukarkan ke meter, jadi
 * `saldoL` tetap di bawah ambang untuk waktu yang cukup lama. Tanpa jeda
 * sepanjang ini, tiap pemeriksaan berikutnya akan melihat keadaan yang sama
 * persis dan membeli lagi — warga bangun pagi dengan selusin tagihan.
 */
const JEDA_MS = 6 * 60 * 60 * 1000;

/**
 * Meter yang pemeriksaannya sedang berjalan di proses ini.
 *
 * Portal memanggil `/live` tiap lima detik dan beberapa tab bisa terbuka
 * sekaligus. Tanpa kuncian, dua permintaan bersamaan sama-sama membaca
 * `isiOtomatisTerakhir` yang masih kosong, lalu keduanya membeli.
 */
const sedangDiperiksa = new Set<string>();

export interface HasilIsiOtomatis {
  dibeli: boolean;
  alasan:
    | "NONAKTIF"
    | "SALDO_CUKUP"
    | "MASIH_DALAM_JEDA"
    | "TANPA_PEMILIK"
    | "SEDANG_BERJALAN"
    | "GAGAL"
    | "DIBELI";
  invoiceId?: string;
}

/**
 * Memeriksa satu meter, dan membeli bila memang perlu.
 *
 * Tidak pernah melempar. Pemanggilnya adalah jalur baca telemetri — gagal
 * di sini tidak boleh membuat warga kehilangan tampilan saldonya.
 */
export async function periksaIsiOtomatis(
  meterId: string,
): Promise<HasilIsiOtomatis> {
  if (sedangDiperiksa.has(meterId)) {
    return { dibeli: false, alasan: "SEDANG_BERJALAN" };
  }
  sedangDiperiksa.add(meterId);

  try {
    const meter = await prisma.meter.findUnique({
      where: { id: meterId },
      include: { pengguna: { include: { golongan: true } } },
    });

    if (!meter || !meter.isiOtomatisAktif) {
      return { dibeli: false, alasan: "NONAKTIF" };
    }

    /*
     * Meter tanpa pemilik tidak bisa ditagih ke siapa pun. Ini bukan
     * keadaan mustahil: meter yang baru dipasang hidup di basis data
     * sebelum dihubungkan ke akun warga.
     */
    if (!meter.penggunaId || !meter.pengguna) {
      return { dibeli: false, alasan: "TANPA_PEMILIK" };
    }

    if (Number(meter.saldoL) >= meter.isiOtomatisAmbangL) {
      return { dibeli: false, alasan: "SALDO_CUKUP" };
    }

    const terakhir = meter.isiOtomatisTerakhir;
    if (terakhir && Date.now() - terakhir.getTime() < JEDA_MS) {
      return { dibeli: false, alasan: "MASIH_DALAM_JEDA" };
    }

    const tarifPerLiter = meter.pengguna.golongan
      ? Number(meter.pengguna.golongan.tarifPerLiter)
      : 7.5;
    const volumeL = meter.isiOtomatisVolumeL;
    const jumlahRp = Math.round(volumeL * tarifPerLiter);
    const invoiceId = `INV-${Date.now().toString().slice(-8)}`;

    /*
     * Penanda waktu ditulis BERSAMA transaksinya, dalam satu transaksi
     * basis data. Ditulis sesudahnya, kegagalan di antara keduanya
     * meninggalkan tagihan tanpa penanda — dan pemeriksaan berikutnya
     * membeli lagi.
     */
    await prisma.$transaction([
      prisma.transaksi.create({
        data: {
          id: invoiceId,
          penggunaId: meter.penggunaId,
          meterId: meter.id,
          jenis: JenisTransaksi.BELI,
          volumeL,
          jumlahRp,
          metode: meter.isiOtomatisMetode,
          status: StatusTransaksi.MENUNGGU,
          kedaluwarsaPada: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
      prisma.meter.update({
        where: { id: meter.id },
        data: { isiOtomatisTerakhir: new Date() },
      }),
    ]);

    /*
     * Dilunaskan lewat jalur yang sama dengan pembelian manual, jadi
     * penerbitan token, audit log, dan email struk semuanya ikut — tanpa
     * satu baris pun yang digandakan di sini.
     */
    await selesaikanPembayaran(invoiceId);

    log.info(
      { meterId: meter.id, invoiceId, volumeL, jumlahRp },
      "[ISI-OTOMATIS] Pembelian otomatis diterbitkan",
    );

    return { dibeli: true, alasan: "DIBELI", invoiceId };
  } catch (err) {
    log.error({ err, meterId }, "[ISI-OTOMATIS] Gagal memeriksa isi otomatis");
    return { dibeli: false, alasan: "GAGAL" };
  } finally {
    sedangDiperiksa.delete(meterId);
  }
}
