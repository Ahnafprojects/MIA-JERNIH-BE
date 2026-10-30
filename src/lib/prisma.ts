/**
 * Satu PrismaClient untuk seluruh proses.
 *
 * Sejak Prisma 7, koneksi dibuat lewat adapter, bukan lewat `url` di
 * `schema.prisma`.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import { env } from "../env.js";

const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
