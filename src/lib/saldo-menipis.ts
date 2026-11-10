import { prisma } from "./prisma.js";
import { env } from "../env.js";
import { emailSaldoMenipis, kirimEmail } from "./email.js";
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
  const penggunaId = meter.penggunaId;

  /*
   * Tautannya menyebut meternya, dan tautan itu pula yang dipakai sebagai
   * penanda "sudah diperingatkan hari ini".
   *
   * Sebelumnya penandanya hanya `penggunaId` + jenis, sehingga warga yang
   * memegang dua sambungan (rumah dan kos) hanya diperingatkan untuk meter
   * yang kebetulan dibaca lebih dulu; meter kedua bisa kering tanpa kabar.
   * Tabel `Notifikasi` tidak punya kolom meter, dan menambah kolom hanya
   * untuk ini tidak sepadan, karena tautan per meter memang yang dibutuhkan
   * halaman Notifikasi: mengetuknya membuka halaman beli untuk meter itu.
   */
  const tautan = `/beli?meter=${encodeURIComponent(meter.id)}`;

  /*
   * Pemeriksaan dan penulisan dijalankan di bawah kunci advisory per meter.
   *
   * Tanpa kunci, dua pembacaan `/live` yang tiba bersamaan (dua tab yang
   * terbuka, atau beranda dan halaman meter sekaligus) sama-sama melihat
   * "belum ada baris hari ini" lalu sama-sama menulis, dan warga melihat
   * dua peringatan kembar di halaman Notifikasi. Kuncinya dilepas otomatis
   * saat transaksi selesai, jadi tidak ada yang bisa tertinggal terkunci.
   */
  const ditulis = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saldo-menipis:${meter.id}`}))`;

    const sudah = await tx.notifikasi.findFirst({
      where: {
        penggunaId,
        jenis: JENIS,
        tautan,
        dibuatPada: { gte: sejak },
      },
      select: { id: true },
    });
    if (sudah) return false;

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
    await tx.notifikasi.create({
      data: {
        penggunaId,
        jenis: JENIS,
        judul: "Saldo air menipis",
        teks: `Sisa saldo meter ${meter.serial} tinggal ${sisa} liter, di bawah batas peringatan Anda ${ambang} liter.`,
        tautan,
      },
    });
    return true;
  });

  if (!ditulis) return "SUDAH_DIPERINGATKAN";

  const pesan = pesanSaldoMenipis({
    serialMeter: meter.serial,
    sisaSaldoL: sisa,
    ambangL: ambang,
    appUrl: env().APP_URL,
  });

  // `void`: pemanggilnya ada di jalur baca yang dipanggil tiap lima detik.
  // `kabariWarga` sudah menelan galatnya sendiri dan tidak pernah melempar.
  void kabariWarga(
    meter.pengguna,
    kunciSaldoMenipis(meter.id, new Date()),
    pesan,
  );

  /*
   * Email, mengikuti saklar `notifikasiSaldoEmail` di Pengaturan konsol.
   *
   * Template `emailSaldoMenipis` sudah lama ada dan README menjanjikan email
   * untuk kejadian ini, tetapi tidak satu baris pun memanggilnya. Dipanggil
   * di sini, SESUDAH baris penanda ditulis, sehingga penjaga harian yang sama
   * juga membatasi email: satu per meter per hari.
   */
  if (meter.pengguna.email && (await emailSaldoAktif())) {
    void kirimEmail(
      emailSaldoMenipis(meter.pengguna.email, meter.serial, sisa, ambang),
    ).catch((e: unknown) =>
      log.warn(
        { meterId, galat: e instanceof Error ? e.message : String(e) },
        "email saldo menipis gagal",
      ),
    );
  }

  log.info(
    { meterId, sisa, ambang },
    "peringatan saldo menipis dikirim",
  );

  return "DIPERINGATKAN";
}

/**
 * Saklar email saldo dari Pengaturan konsol (`kunci: "notifikasi"`).
 *
 * Bawaannya MENYALA, sama dengan nilai bawaan yang ditampilkan
 * `GET /api/admin/pengaturan/notifikasi`: pengaturan yang belum pernah
 * disimpan tidak boleh berarti "mati" di sini sementara layar konsol
 * menunjukkannya "menyala".
 */
async function emailSaldoAktif(): Promise<boolean> {
  const baris = await prisma.pengaturan.findUnique({
    where: { kunci: "notifikasi" },
    select: { nilai: true },
  });
  const nilai = baris?.nilai as { notifikasiSaldoEmail?: unknown } | null;
  return nilai?.notifikasiSaldoEmail !== false;
}
