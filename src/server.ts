import { buatApp } from "./app.js";
import { env } from "./env.js";

const cfg = env();
const app = buatApp();

const server = app.listen(cfg.PORT, () => {
  console.info(`[jernih-api] siap di http://localhost:${cfg.PORT}`);
});

for (const sinyal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinyal, () => {
    console.info(`[jernih-api] ${sinyal} diterima, menutup server…`);
    server.close(() => process.exit(0));
  });
}
