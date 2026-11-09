FROM node:22-alpine AS builder
WORKDIR /layanan
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /layanan
ENV NODE_ENV=production

COPY --from=builder /layanan/node_modules ./node_modules
COPY --from=builder /layanan/dist ./dist
COPY package*.json ./

# Kredensial pemasangan WhatsApp tinggal di sini, dan direktori ini WAJIB
# dipasangi volume di compose. Tanpa volume, tiap penyebaran menghapus
# sesinya dan menuntut pemindaian QR ulang — padahal penyebaran terjadi di
# setiap push ke `main`.
RUN mkdir -p /data/wa-sesi
VOLUME ["/data"]

EXPOSE 5310
CMD ["node", "dist/server.js"]
