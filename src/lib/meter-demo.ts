/**
 * Pemberian meter otomatis saat akun baru selesai verifikasi.
 *
 * ── Kenapa ada ────────────────────────────────────────────────────────
 *
 * Sebelumnya warga baru mentok setelah mendaftar: portal menuntut sebuah meter
 * terhubung, sementara menghubungkan meter mengharuskan ID atau nomor seri yang
 * SUDAH ADA di basis data dan belum dimiliki siapa pun. Orang yang baru membuka
 * aplikasi — termasuk juri — tidak punya nomor itu, jadi tidak ada satu pun
 * halaman portal yang bisa dibuka. Pendaftaran berhasil, tetapi tidak membawa
 * ke mana-mana.
 *
 * ── Kenapa membuat baru, bukan mengambil dari kolam ───────────────────
 *
 * Meter yang belum dimiliki memang ada, tetapi jumlahnya terbatas dan isinya
 * sisa artefak pengujian (`MTR_CFG_…`, `MTR_INS_…`) tanpa riwayat apa pun.
 * Membagikannya berarti kolamnya habis setelah beberapa pendaftar, dan yang
 * kebagian pun melihat portal kosong. Membuat meter baru per akun tidak punya
 * dua masalah itu.
 *
 * Meter asli yang dipasang di lapangan tetap dihubungkan lewat
 * `POST /api/meter/hubungkan` seperti biasa — jalur itu tidak diubah.
 */
import { prisma } from "./prisma.js";

/** Berapa hari riwayat pemakaian yang disemai untuk meter baru. */
const HARI_RIWAYAT = 7;

/**
 * Pola pemakaian rumah tangga sehari, dalam liter per jam (indeks 0–23).
 *
 * Bentuknya sengaja mengikuti kebiasaan nyata: dua puncak di pagi dan sore,
 * nyaris nol saat dini hari. Grafik dan peta panas di portal jadi langsung
 * terbaca sebagai pola, bukan deretan angka acak yang tidak berarti apa-apa.
 */
const POLA_JAM = [
  2, 1, 1, 1, 2, 8, 24, 38, 30, 18, 12, 14,
  16, 12, 10, 11, 18, 32, 36, 26, 18, 12, 7, 3,
];

/** Saldo awal supaya portal tidak langsung menampilkan keadaan kritis. */
const SALDO_AWAL_L = 5000;

/** Angka acak kecil agar tiap akun tidak memiliki grafik yang persis sama. */
const goyang = (nilai: number): number => {
  const faktor = 0.75 + Math.random() * 0.5; // 0,75–1,25
  return Math.round(nilai * faktor * 10) / 10;
};

/**
 * Memastikan sebuah akun punya meter yang bisa dibuka di portal.
 *
 * Aman dipanggil berulang: kalau akun sudah memiliki meter — entah hasil
 * pemberian ini atau hasil menghubungkan meter sungguhan — fungsi ini tidak
 * melakukan apa-apa.
 *
 * Tidak pernah melempar. Kegagalan di sini tidak boleh menggagalkan verifikasi
 * email; pengguna tetap bisa masuk dan menghubungkan meter secara manual.
 *
 * @returns id meter yang dimiliki akun, atau null bila gagal.
 */
export async function pastikanMeterDemo(
  penggunaId: string,
  namaPengguna: string,
): Promise<string | null> {
  try {
    const sudahPunya = await prisma.meter.findFirst({
      where: { penggunaId },
      select: { id: true },
    });
    if (sudahPunya) return sudahPunya.id;

    // Zona dipakai peta dan perbandingan pemakaian antarwarga. Kalau belum ada
    // zona sama sekali, meter tetap dibuat tanpa zona — portal masih jalan.
    const zona = await prisma.zona.findFirst({ select: { id: true } });

    const urut = (await prisma.meter.count()) + 1;
    const nomor = String(urut).padStart(4, "0");
    const unik = Date.now().toString(36).toUpperCase().slice(-5);

    const meter = await prisma.meter.create({
      data: {
        id: `P${nomor}-${unik}`,
        node: `NODE.SIM-${unik}`,
        serial: `JRN-${nomor}-${unik}`,
        label: "Rumah Saya",
        alamat: "Belum diisi",
        zonaId: zona?.id ?? null,
        penggunaId,
        saldoL: SALDO_AWAL_L,
        volumeTotalL: 0,
        debitLpm: 0,
        relay: "AKTIF",
        saklarOn: true,
        daring: true,
        terakhirTerlihat: new Date(),
        versiFirmware: "FW 1.1 · SIM",
        rssi: -62,
      },
      select: { id: true },
    });

    await semaiRiwayat(meter.id);
    return meter.id;
  } catch (err) {
    // Sengaja ditelan: verifikasi email lebih penting daripada meter bawaan.
    console.error(
      `[meter-demo] gagal menyiapkan meter untuk ${namaPengguna}:`,
      err,
    );
    return null;
  }
}

/**
 * Menyemai riwayat pemakaian per jam supaya grafik dan peta panas 7×24 di
 * halaman Pemakaian langsung berisi.
 *
 * Tanpa ini, meter baru menghasilkan halaman kosong total — secara teknis
 * benar, tetapi membuat fitur yang paling banyak dikerjakan jadi tidak
 * terlihat sama sekali oleh pemakai baru.
 */
async function semaiRiwayat(meterId: string): Promise<void> {
  const sekarang = new Date();
  const baris: Array<{ meterId: string; jam: Date; volumeL: number }> = [];
  let total = 0;

  for (let mundur = HARI_RIWAYAT * 24 - 1; mundur >= 0; mundur -= 1) {
    const jam = new Date(sekarang.getTime() - mundur * 60 * 60 * 1000);
    jam.setMinutes(0, 0, 0);

    const volumeL = goyang(POLA_JAM[jam.getHours()] ?? 0);
    total += volumeL;
    baris.push({ meterId, jam, volumeL });
  }

  await prisma.emberPemakaian.createMany({ data: baris, skipDuplicates: true });

  // Volume total meter harus sejalan dengan riwayat yang baru disemai, kalau
  // tidak angka di kartu meter akan bertentangan dengan grafiknya sendiri.
  await prisma.meter.update({
    where: { id: meterId },
    data: { volumeTotalL: Math.round(total * 100) / 100 },
  });
}
