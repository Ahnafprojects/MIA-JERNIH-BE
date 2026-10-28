/**
 * Modul pengiriman email transaksional Jernih.
 *
 * Menggunakan Nodemailer dengan fallback mock/log bila MAIL_ENABLED=false.
 * Tata letak berbasis <table>, lebar maksimal 600px, warna hex inline (karena
 * klien email seperti Outlook/Gmail mengabaikan CSS eksternal/CSS variables).
 */
import nodemailer from "nodemailer";
import { env } from "../env.js";
import { log } from "./log.js";

export type JenisEmail =
  | "daftar"
  | "masuk_baru"
  | "lupa_sandi"
  | "pembelian_lunas"
  | "saldo_menipis"
  | "tiket_diperbarui"
  | "broadcast";

export interface OpsiKirimEmail {
  ke: string;
  subjek: string;
  teks: string;
  html: string;
}

let transporterInstance: nodemailer.Transporter | null = null;

function dapatkanTransporter() {
  if (transporterInstance) return transporterInstance;
  const cfg = env();
  if (!cfg.SMTP_HOST) return null;

  transporterInstance = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465,
    auth: cfg.SMTP_USER
      ? {
          user: cfg.SMTP_USER,
          pass: cfg.SMTP_PASS,
        }
      : undefined,
  });
  return transporterInstance;
}

/**
 * Mengirim email transaksional secara aman.
 * Jika MAIL_ENABLED=false atau pengiriman gagal, tidak melempar galat ke pemanggil
 * agar alur utama (seperti pendaftaran pengguna) tidak dibatalkan.
 */
export async function kirimEmail(opsi: OpsiKirimEmail): Promise<boolean> {
  const cfg = env();
  if (!cfg.MAIL_ENABLED) {
    log.info(
      { ke: opsi.ke, subjek: opsi.subjek },
      "[EMAIL-MOCK] Pengiriman email dilewati (MAIL_ENABLED=false)",
    );
    return true;
  }

  try {
    const transporter = dapatkanTransporter();
    if (!transporter) {
      log.warn(
        { ke: opsi.ke, subjek: opsi.subjek },
        "[EMAIL] SMTP_HOST belum dikonfigurasi, email gagal dikirim",
      );
      return false;
    }

    await transporter.sendMail({
      from: cfg.MAIL_FROM,
      to: opsi.ke,
      subject: opsi.subjek,
      text: opsi.teks,
      html: opsi.html,
    });

    log.info({ ke: opsi.ke, subjek: opsi.subjek }, "[EMAIL] Berhasil terkirim");
    return true;
  } catch (err) {
    log.error({ err, ke: opsi.ke, subjek: opsi.subjek }, "[EMAIL] Gagal mengirim email");
    return false;
  }
}

/* ── Template pembungkus ─────────────────────────────────────────────── */

function bungkusTemplate(judul: string, kontenHtml: string): string {
  // Warna hex inline digunakan secara eksplisit demi kompatibilitas klien email
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${judul}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f5f7; padding: 24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden; margin: 0 16px;">
          <!-- Header -->
          <tr>
            <td style="background-color: #0284c7; padding: 20px 24px;">
              <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">JERNIH</span>
              <span style="display: block; font-size: 12px; color: #bae6fd; margin-top: 4px;">Transparansi Layanan Air Bersih</span>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 28px 24px 32px 24px; font-size: 15px; line-height: 1.6; color: #374151;">
              ${kontenHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 16px 24px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; text-align: center;">
              Pemberitahuan otomatis dari sistem PDAM Jernih. Mohon tidak membalas email ini secara langsung.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── 7 Templat email transaksional ───────────────────────────────────── */

export function emailVerifikasiDaftar(email: string, kode6Digit: string): OpsiKirimEmail {
  const subjek = `Kode Verifikasi Akun Jernih: ${kode6Digit}`;
  const teks = `Halo,\n\nKode verifikasi akun Jernih Anda adalah: ${kode6Digit}\nKode ini berlaku selama 10 menit. Jangan berikan kode ini kepada siapa pun.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #111827;">Verifikasi Alamat Email Anda</h2>
     <p>Terima kasih telah mendaftar di portal transparansi air PDAM Jernih. Gunakan kode 6 digit di bawah ini untuk menyelesaikan pendaftaran akun Anda:</p>
     <div style="background-color: #f0f9ff; border: 1px dashed #0284c7; border-radius: 6px; padding: 16px; text-align: center; margin: 24px 0;">
       <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #0284c7; font-family: monospace;">${kode6Digit}</span>
     </div>
     <p style="font-size: 13px; color: #6b7280;">Kode ini hanya berlaku selama <strong>10 menit</strong>. Jika Anda tidak merasa mendaftar di Jernih, silakan abaikan email ini.</p>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailMasukBaru(email: string, kode6Digit: string): OpsiKirimEmail {
  const subjek = `Kode Keamanan Masuk Perangkat Baru: ${kode6Digit}`;
  const teks = `Halo,\n\nKami mendeteksi percobaan masuk dari perangkat baru untuk akun Anda (${email}).\nKode verifikasi Anda adalah: ${kode6Digit}\nKode ini berlaku 10 menit.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #111827;">Percobaan Masuk Perangkat Baru</h2>
     <p>Kami mendeteksi aktivitas masuk dari peramban atau perangkat baru untuk akun <strong>${email}</strong>.</p>
     <p>Gunakan kode verifikasi berikut untuk mengonfirmasi akses Anda:</p>
     <div style="background-color: #fef2f2; border: 1px dashed #ef4444; border-radius: 6px; padding: 16px; text-align: center; margin: 24px 0;">
       <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #b91c1c; font-family: monospace;">${kode6Digit}</span>
     </div>
     <p style="font-size: 13px; color: #6b7280;">Kode ini kedaluwarsa dalam 10 menit. Bila bukan Anda yang mencoba masuk, segera ganti kata sandi Anda.</p>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailLupaSandi(email: string, tautanAturUlang: string): OpsiKirimEmail {
  const subjek = "Atur Ulang Kata Sandi Akun Jernih";
  const teks = `Halo,\n\nAnda meminta tautan untuk mengatur ulang kata sandi akun Jernih Anda.\nBuka tautan berikut (berlaku 30 menit, sekali pakai):\n${tautanAturUlang}\n\nJika bukan Anda yang meminta, abaikan pesan ini.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #111827;">Permintaan Atur Ulang Kata Sandi</h2>
     <p>Kami menerima permintaan untuk menyetel ulang kata sandi akun Jernih Anda.</p>
     <div style="text-align: center; margin: 28px 0;">
       <a href="${tautanAturUlang}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Atur Ulang Kata Sandi</a>
     </div>
     <p style="font-size: 13px; color: #6b7280;">Tautan di atas hanya berlaku selama <strong>30 menit</strong> dan sekali pakai. Jika tombol di atas tidak berfungsi, salin tautan berikut ke peramban Anda:<br><span style="word-break: break-all; color: #0284c7;">${tautanAturUlang}</span></p>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailPembelianLunas(
  email: string,
  detail: {
    invoiceId: string;
    meterId: string;
    volumeL: number;
    jumlahRp: number;
    kodeToken: string;
    waktu: string;
  },
): OpsiKirimEmail {
  const subjek = `Struk Pembelian & Kode Token Air #${detail.invoiceId}`;
  const teks = `Halo,\n\nPembelian air Anda telah lunas.\nInvoice: ${detail.invoiceId}\nID Meter: ${detail.meterId}\nVolume: ${detail.volumeL.toLocaleString("id-ID")} Liter\nTotal: Rp ${detail.jumlahRp.toLocaleString("id-ID")}\n\nKODE TOKEN AIR ANDA:\n${detail.kodeToken}\n\nMasukkan kode di atas ke meter air atau tukarkan di aplikasi Jernih.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #111827;">Pembelian Berhasil & Struk Pembayaran</h2>
     <p>Pembayaran untuk pembelian air prabayar Anda telah berhasil diverifikasi.</p>
     <div style="background-color: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 18px; margin: 20px 0; text-align: center;">
       <span style="font-size: 13px; color: #166534; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Kode Token Air Anda</span>
       <div style="font-size: 30px; font-weight: 800; letter-spacing: 4px; color: #15803d; font-family: monospace; margin: 8px 0;">${detail.kodeToken}</div>
       <span style="font-size: 12px; color: #4ade80;">Tukarkan melalui keypad fisik meter atau menu Tukar Token di aplikasi Jernih</span>
     </div>
     <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; padding: 12px 0; margin: 16px 0; font-size: 14px;">
       <tr><td style="padding: 6px 0; color: #6b7280;">No. Invoice</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${detail.invoiceId}</td></tr>
       <tr><td style="padding: 6px 0; color: #6b7280;">ID Meter</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${detail.meterId}</td></tr>
       <tr><td style="padding: 6px 0; color: #6b7280;">Volume Air</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${detail.volumeL.toLocaleString("id-ID")} Liter</td></tr>
       <tr><td style="padding: 6px 0; color: #6b7280;">Total Biaya</td><td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0284c7;">Rp ${detail.jumlahRp.toLocaleString("id-ID")}</td></tr>
     </table>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailSaldoMenipis(
  email: string,
  meterId: string,
  sisaSaldoL: number,
  ambangL: number,
): OpsiKirimEmail {
  const subjek = `Peringatan: Saldo Air Meter ${meterId} Menipis (${sisaSaldoL.toLocaleString("id-ID")} L)`;
  const teks = `Halo,\n\nSisa saldo air untuk meter ${meterId} saat ini adalah ${sisaSaldoL.toLocaleString("id-ID")} liter (di bawah batas peringatan Anda: ${ambangL.toLocaleString("id-ID")} liter).\nSegera lakukan pengisian token agar pasokan air tidak terputus otomatis.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #b45309;">Peringatan Saldo Air Menipis</h2>
     <p>Saldo air pada meter <strong>${meterId}</strong> telah berada di bawah batas peringatan yang Anda tentukan.</p>
     <div style="background-color: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 14px; margin: 18px 0;">
       <p style="margin: 0; font-size: 14px; color: #92400e;">
         Sisa Saldo: <strong>${sisaSaldoL.toLocaleString("id-ID")} Liter</strong><br>
         Batas Peringatan: ${ambangL.toLocaleString("id-ID")} Liter
       </p>
     </div>
     <p>Segera lakukan pembelian dan penukaran token air sebelum saldo mencapai 0 liter dan katup relay tertutup otomatis.</p>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailTiketDiperbarui(
  email: string,
  nomorTiket: string,
  statusLama: string,
  statusBaru: string,
  catatan?: string,
): OpsiKirimEmail {
  const subjek = `Pembaruan Status Tiket Pengaduan #${nomorTiket}`;
  const teks = `Halo,\n\nStatus pengaduan Anda (${nomorTiket}) telah diperbarui dari ${statusLama} menjadi: ${statusBaru}.\n${catatan ? `Catatan petugas: ${catatan}\n` : ""}Anda dapat melacak riwayat lengkap di halaman publik Jernih dengan memasukkan nomor tiket.\n\nSalam,\nTim Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #111827;">Pembaruan Pengaduan Layanan</h2>
     <p>Laporan pengaduan air Anda dengan nomor <strong>${nomorTiket}</strong> telah diperbarui oleh petugas teknis.</p>
     <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin: 16px 0; font-size: 14px;">
       <tr><td style="padding: 4px 0; color: #6b7280;">Nomor Tiket:</td><td style="padding: 4px 0; font-weight: 600;">${nomorTiket}</td></tr>
       <tr><td style="padding: 4px 0; color: #6b7280;">Status Baru:</td><td style="padding: 4px 0; font-weight: 700; color: #0284c7;">${statusBaru}</td></tr>
       ${catatan ? `<tr><td style="padding: 4px 0; color: #6b7280;">Keterangan:</td><td style="padding: 4px 0;">${catatan}</td></tr>` : ""}
     </table>
     <p style="font-size: 13px; color: #6b7280;">Lacak perkembangan pengaduan tanpa login di menu Lacak Publik Jernih.</p>`,
  );
  return { ke: email, subjek, teks, html };
}

export function emailBroadcast(
  email: string,
  judulPesan: string,
  isiPesan: string,
): OpsiKirimEmail {
  const subjek = `Pengumuman PDAM Jernih: ${judulPesan}`;
  const teks = `Halo,\n\n${judulPesan}\n\n${isiPesan}\n\nSalam,\nPDAM Jernih`;
  const html = bungkusTemplate(
    subjek,
    `<h2 style="margin-top: 0; font-size: 18px; color: #0284c7;">${judulPesan}</h2>
     <div style="font-size: 15px; line-height: 1.6; margin: 16px 0; color: #374151;">
       ${isiPesan.replace(/\n/g, "<br>")}
     </div>`,
  );
  return { ke: email, subjek, teks, html };
}
