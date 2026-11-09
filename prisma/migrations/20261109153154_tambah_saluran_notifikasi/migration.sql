-- AlterTable
ALTER TABLE "Pengguna" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "waNomor" TEXT,
ADD COLUMN     "waOptIn" BOOLEAN NOT NULL DEFAULT false;
