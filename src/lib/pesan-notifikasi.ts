/**
 * Penyusun teks notifikasi dan kunci idempotensinya.
 *
 * Dipisah dari rutenya supaya teks dan kuncinya bisa diuji tanpa menyalakan
 * Express, dan supaya satu kejadian tidak punya dua versi pesan yang
 * menyimpang diam-diam di dua tempat.
 *
 * ── Teks polos, tanpa markdown ────────────────────────────────────────
 *
 * Tidak ada `*tebal*` atau `_miring_` di sini, dan itu bukan kelupaan.
 * WhatsApp merender tanda bintang sebagai huruf tebal; `PengirimTelegram`
 * memanggil `sendMessage` TANPA `parse_mode`, sehingga Telegram menampilkan
 * tanda bintangnya apa adanya. Satu teks yang sama akan terlihat rapi di
 * satu saluran dan berantakan di saluran lain.
 *
 * Kalau nanti markdown memang diinginkan, formatnya harus disusun per
 * saluran, bukan ditambahkan di sini.
 *
 * ── Gaya bahasa ──────────────────────────────────────────────────────
 *
 * Mengikuti `docs/visual.md`: kalimat deklaratif, tanpa em dash, tanpa
 * konstruksi "X, bukan Y", tanpa metafora. Pesan WhatsApp juga harus
 * pendek; ini bukan email, dan warga membacanya di layar kunci.
 */

/** Label status tiket yang dibaca warga. Enum-nya huruf besar semua. */
const LABEL_STATUS: Record<string, string> = {
  BARU: "Baru",
  DIPROSES: "Sedang diproses",
  SELESAI: "Selesai",
};

function labelStatus(status: string): string {
  return LABEL_STATUS[status] ?? status;
}

/** Angka dengan notasi Indonesia: titik sebagai pemisah ribuan. */
function angkaId(n: number): string {
  return n.toLocaleString("id-ID");
}

/**
 * Batas panjang catatan petugas yang ikut dikutip.
 *
 * Catatan ditulis bebas oleh petugas dan bisa sepanjang apa pun. Pesan
 * WhatsApp yang menjulur beberapa layar berhenti dibaca, dan bagian yang
 * paling penting justru ada di awal.
 */
const MAKS_CATATAN = 180;

function ringkasCatatan(catatan: string): string {
  const bersih = catatan.replace(/\s+/g, " ").trim();
  if (bersih.length <= MAKS_CATATAN) return bersih;
  return `${bersih.slice(0, MAKS_CATATAN - 1).trimEnd()}…`;
}

/* ── Kunci idempotensi ─────────────────────────────────────────────────
 *
 * Semua kunci diturunkan dari KEJADIANNYA, tidak pernah dari jam saat
 * fungsinya dipanggil. Layanan notifikasi menolak kunci yang sudah pernah
 * diproses, jadi percobaan ulang setelah jaringan putus tidak menghasilkan
 * pesan kedua untuk satu kejadian yang sama.
 */

export function kunciTiket(nomorTiket: string, statusBaru: string): string {
  return `tiket:${nomorTiket}:${statusBaru}`;
}

export function kunciTransaksi(invoiceId: string): string {
  return `transaksi:${invoiceId}:LUNAS`;
}

/**
 * Kunci peringatan saldo: satu per meter per HARI.
 *
 * Tanggalnya sengaja ikut, dan ini pengamannya yang sebenarnya. Saldo meter
 * hanya berubah saat token ditukarkan, sementara pemeriksaannya menumpang
 * jalur baca yang dipanggil portal tiap lima detik. Tanpa tanggal di kunci,
 * satu saldo yang duduk di bawah ambang akan memicu pesan pada setiap
 * pembacaan, dan warga menerima ratusan pesan dalam sehari. Nomor pengirimnya
 * nomor bisnis sungguhan; dilaporkan sebagai spam berarti nomor itu diblokir.
 *
 * Tanggal dihitung di zona Asia/Jakarta, bukan UTC. Dengan UTC, pergantian
 * harinya jatuh pukul 07.00 WIB, sehingga warga bisa menerima dua peringatan
 * dalam satu pagi yang sama.
 */
export function kunciSaldoMenipis(meterId: string, waktu: Date): string {
  const tanggal = waktu.toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
  });
  return `saldo-menipis:${meterId}:${tanggal}`;
}

/* ── Teks pesan ────────────────────────────────────────────────────── */

export function pesanTiketDiperbarui(opsi: {
  nomorTiket: string;
  statusLama: string;
  statusBaru: string;
  /* `| undefined` eksplisit, bukan sekadar `?`. Proyek ini menyalakan
     `exactOptionalPropertyTypes`, jadi `catatan?: string` menolak nilai
     `undefined` yang dioper langsung — dan `catatan` memang datang dari
     `z.string().optional()` yang persis menghasilkan itu. */
  catatan?: string | undefined;
  appUrl: string;
}): string {
  const baris = [
    `Jernih: pengaduan ${opsi.nomorTiket}`,
    "",
    `Status berubah dari ${labelStatus(opsi.statusLama)} menjadi ${labelStatus(opsi.statusBaru)}.`,
  ];

  if (opsi.catatan?.trim()) {
    baris.push(`Catatan petugas: ${ringkasCatatan(opsi.catatan)}`);
  }

  baris.push(
    "",
    `Lacak: ${opsi.appUrl}/lacak?nomor=${encodeURIComponent(opsi.nomorTiket)}`,
  );

  return baris.join("\n");
}

/**
 * Struk pembelian, dengan kode token LENGKAP.
 *
 * Kodenya tidak disamarkan, dan itu memang gunanya. Warga membeli token untuk
 * dipakai, kadang baru besok, dan kode yang dibintangi membuat pesan ini
 * tidak ada gunanya saat dibutuhkan. Perlakuannya sama dengan email struk dan
 * struk di halaman riwayat.
 */
export function pesanPembelianLunas(opsi: {
  invoiceId: string;
  volumeL: number;
  jumlahRp: number;
  kodeToken: string;
  appUrl: string;
}): string {
  return [
    `Jernih: pembelian ${opsi.invoiceId} lunas`,
    "",
    `Volume: ${angkaId(opsi.volumeL)} liter`,
    `Total: Rp ${angkaId(opsi.jumlahRp)}`,
    "",
    `Kode token: ${opsi.kodeToken}`,
    "",
    "Masukkan kode di halaman Isi Token, atau langsung di keypad meter.",
    `Struk: ${opsi.appUrl}/riwayat`,
  ].join("\n");
}

export function pesanSaldoMenipis(opsi: {
  serialMeter: string;
  sisaSaldoL: number;
  ambangL: number;
  appUrl: string;
}): string {
  return [
    `Jernih: saldo meter ${opsi.serialMeter} menipis`,
    "",
    `Sisa saldo: ${angkaId(opsi.sisaSaldoL)} liter`,
    `Batas peringatan Anda: ${angkaId(opsi.ambangL)} liter`,
    "",
    "Isi token sebelum saldo habis agar air tidak berhenti.",
    `Beli token: ${opsi.appUrl}/beli`,
  ].join("\n");
}
