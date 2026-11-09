import { prisma } from "./prisma.js";
import { env } from "../env.js";
import { log } from "./log.js";
import { kabariWarga } from "./notifikasi.js";
import { kunciSaldoMenipis, pesanSaldoMenipis } from "./pesan-notifikasi.js";

/**
 * Peringatan saldo menipis.
 *
 * ── Kenapa fitur ini sebelumnya tidak ada sama sekali ─────────────────
 *
 * `emailSaldoMenipis` sudah lama ada di `src/lib/email.ts`, tetapi tidak
 * pernah dipanggil satu kali pun dari kode produksi — hanya dari berkas uji.
 * Jadi yang kurang bukan salurannya, melainkan PEMICUNYA.
 *
 * Sebabnya tercatat di `isi-otomatis.ts`: backend ini tidak punya jalur
 * masuk telemetri, dan `saldoL` hanya berubah saat token ditukarkan.
 * Artinya tidak ada momen "saldo baru saja turun" yang bisa dipakai sebagai
 * pemicu. Yang tersedia hanyalah saat saldo DIBACA.
 *
 * ── Kenapa TERPISAH dari periksaIsiOtomatis ───────────────────────────
 *
 * Keduanya dipanggil dari tempat yang sama dan sama-sama membandingkan
 * saldo dengan sebuah ambang, jadi menempelkannya ke sana terlihat hemat.
 * Itu akan salah: `periksaIsiOtomatis` berhenti lebih awal dengan
 * `NONAKTIF` begitu `isiOtomatisAktif` bernilai false — padahal justru pada
 * warga yang TIDAK memakai isi otomatis peringatan ini paling dibutuhkan.
 * Mereka tidak punya jaring pengaman lain.
 *
 * Ambangnya pun berbeda: `isiOtomatisAmbangL` adalah titik beli otomatis,
 * sedangkan `ambangPeringatanL` adalah titik warga ingin diberi tahu. Satu
 * urusan mesin, satu urusan orang.
 *
 * ── Kenapa penjaganya baris Notifikasi, bukan peta di memori ──────────
 *
 * `GET /api/meter/:id/live` dipanggil portal tiap LIMA DETIK selama halaman
 * beranda terbuka. Tanpa penjaga, satu warga yang membuka berandanya
 * setengah jam akan menerima ratusan pesan, dan nomor pengirimnya nomor
 * bisnis sungguhan: dilaporkan sebagai spam berarti nomor itu diblokir.
 *
 * Peta di memori akan cukup untuk satu umur proses, tetapi kontainer ini
 * dibuat ulang pada SETIAP push ke `main`, dan setiap pembuatan ulang
 * mengosongkan petanya. Baris `Notifikasi` bertahan melewati itu.
 *
 * Barisnya juga bukan sekadar penanda: tabel `Notifikasi` memang
 * menyediakan jenis `SALDO`, dan warga melihatnya di halaman Notifikasi.
 * Jadi satu baris ini mengerjakan dua hal yang keduanya memang diinginkan.
 */

/** Jenis baris `Notifikasi` yang dipakai sebagai penanda sekaligus isi. */
const JENIS = "SALDO";

/**
 * Awal hari menurut Asia/Jakarta, dikembalikan sebagai `Date` UTC.
 *
 * Memakai awal hari UTC akan membuat pergantian harinya jatuh pukul 07.00
 * WIB, sehingga warga bisa menerima dua peringatan dalam satu pagi yang
 * sama. Zona waktu proyek ini Asia/Jakarta.
 */
function awalHariWib(waktu: Date): Date {
  const tanggalWib = waktu.toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
  });
  return new Date(`${tanggalWib}T00:00:00+07:00`);
}

export type HasilSaldoMenipis =
  | "TIDAK_DITEMUKAN"
  | "TANPA_PEMILIK"
  | "SALDO_AMAN"
  | "SUDAH_DIPERINGATKAN"
  | "DIPERINGATKAN";

export async function periksaSaldoMenipis(
  meterId: string,
): Promise<HasilSaldoMenipis> {
  const meter = await prisma.meter.findUnique({
    where: { id: meterId },
    include: { pengguna: true },
  });

  if (!meter) return "TIDAK_DITEMUKAN";

  /*
   * Meter tanpa pemilik bukan keadaan mustahil: meter yang baru dipasang
   * hidup di basis data sebelum dihubungkan ke akun warga.
   */
  if (!meter.penggunaId || !meter.pengguna) return "TANPA_PEMILIK";

  const sisa = Number(meter.saldoL);
  const ambang = meter.pengguna.ambangPeringatanL;
  if (sisa > ambang) return "SALDO_AMAN";

  const sejak = awalHariWib(new Date());
  const sudah = await prisma.notifikasi.findFirst({
    where: {
      penggunaId: meter.penggunaId,
      jenis: JENIS,
      dibuatPada: { gte: sejak },
    },
    select: { id: true },
  });
  if (sudah) return "SUDAH_DIPERINGATKAN";

  const pesan = pesanSaldoMenipis({
    serialMeter: meter.serial,
    sisaSaldoL: sisa,
    ambangL: ambang,
    appUrl: env().APP_URL,
  });

  /*
   * Baris Notifikasi ditulis LEBIH DULU, baru pesannya dititipkan.
   *
   * Urutannya menentukan arah kegagalannya. Kalau pesannya dititipkan dulu
   * lalu penulisan baris gagal, pembacaan lima detik berikutnya akan
   * mengirim lagi, dan lagi — persis kegagalan yang penjaga ini ada untuk
   * mencegahnya. Dengan urutan ini, kegagalan terburuknya adalah satu
   * peringatan yang tidak terkirim hari itu, dan warga tetap melihatnya di
   * halaman Notifikasi.
   */
  await prisma.notifikasi.create({
    data: {
      penggunaId: meter.penggunaId,
      jenis: JENIS,
      judul: "Saldo air menipis",
      teks: `Sisa saldo meter ${meter.serial} tinggal ${sisa} liter, di bawah batas peringatan Anda ${ambang} liter.`,
      tautan: "/beli",
    },
  });

  // `void`: pemanggilnya ada di jalur baca yang dipanggil tiap lima detik.
  // `kabariWarga` sudah menelan galatnya sendiri dan tidak pernah melempar.
  void kabariWarga(
    meter.pengguna,
    kunciSaldoMenipis(meter.id, new Date()),
    pesan,
  );

  log.info(
    { meterId, sisa, ambang },
    "peringatan saldo menipis dikirim",
  );

  return "DIPERINGATKAN";
}
