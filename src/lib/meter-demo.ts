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
 * sisa artefak pengujian (`MTR_CFG_…`, `MTR_INS_…`). Kolamnya akan habis
 * setelah beberapa pendaftar. Membuat meter baru per akun tidak punya batas itu.
 *
 * ── Yang TIDAK diberikan ──────────────────────────────────────────────
 *
 * Saldo. Meter baru dimulai dari nol liter dengan relay nonaktif, persis
 * seperti sambungan yang baru dipasang dan belum pernah diisi. Air prabayar
 * berarti saldo hanya bertambah dari token yang dibeli — memberi saldo gratis
 * saat mendaftar membuat seluruh alur beli-token kehilangan maknanya, dan
 * angkanya tidak akan pernah cocok dengan riwayat transaksi mana pun.
 *
 * Meter asli yang dipasang di lapangan tetap dihubungkan lewat
 * `POST /api/meter/hubungkan` seperti biasa — jalur itu tidak diubah.
 */
import { prisma } from "./prisma.js";

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
        /*
         * Saldo DIMULAI DARI NOL. Air prabayar: saldo hanya boleh bertambah
         * dari token yang dibeli, tidak pernah muncul sendiri saat mendaftar.
         * Memberi saldo gratis membuat seluruh alur beli-token kehilangan
         * maknanya, dan angkanya tidak akan pernah cocok dengan riwayat
         * transaksi mana pun.
         */
        saldoL: 0,
        volumeTotalL: 0,
        debitLpm: 0,
        /*
         * Relay NONAKTIF, bukan AKTIF. Aturannya tegas di `rute/meter.ts`:
         * relay hanya boleh aktif bila saldo > 0 DAN saklar fisik ON. Menyetel
         * AKTIF saat saldo nol membuat portal menampilkan keadaan yang
         * melanggar aturannya sendiri.
         */
        relay: "NONAKTIF",
        saklarOn: true,
        daring: true,
        terakhirTerlihat: new Date(),
        versiFirmware: "FW 1.1 · SIM",
        rssi: -62,
      },
      select: { id: true },
    });

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
