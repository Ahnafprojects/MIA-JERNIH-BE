import { prisma } from "./prisma.js";

/**
 * Nama aktor untuk kolom `AuditLog.aktorNama`.
 *
 * Kolom itu ada justru supaya jejak audit tetap terbaca SESUDAH akun
 * pelakunya dihapus atau relasinya putus. Sebelumnya hampir semua rute
 * mengisinya dengan `req.pengguna!.id`, sehingga begitu relasi `aktor`
 * kosong, halaman audit menampilkan cuid seperti `cm3x9...` sebagai nama
 * petugas. Log yang tidak bisa dibaca manusia tidak memenuhi tujuannya.
 *
 * Kalau penggunanya tidak ditemukan, id tetap dikembalikan: jejak yang
 * menyebut id masih lebih berguna daripada kolom kosong.
 */
export async function namaAktor(penggunaId: string): Promise<string> {
  const pengguna = await prisma.pengguna.findUnique({
    where: { id: penggunaId },
    select: { nama: true },
  });
  return pengguna?.nama || penggunaId;
}
