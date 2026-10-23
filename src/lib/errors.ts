/**
 * Galat aplikasi dengan bentuk jawaban seragam `{error:{code,message}}`.
 *
 * `message` SELALU Bahasa Indonesia dan siap ditampilkan apa adanya di UI.
 * Frontend tidak boleh perlu menerjemahkan kode status jadi kalimat sendiri —
 * kalau ia melakukannya, pesan yang tepat dari sini akan tertimpa pesan
 * generik, dan pengguna kehilangan petunjuk sebenarnya.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, pesan: string) =>
  new AppError(400, code, pesan);

export const unauthorized = (pesan: string, code = "UNAUTHORIZED") =>
  new AppError(401, code, pesan);

export const forbidden = (pesan: string, code = "FORBIDDEN") =>
  new AppError(403, code, pesan);

export const notFound = (pesan: string, code = "NOT_FOUND") =>
  new AppError(404, code, pesan);

export const konflik = (pesan: string, code = "CONFLICT") =>
  new AppError(409, code, pesan);
