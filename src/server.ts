import { buatApp } from "./app.js";
import { env } from "./env.js";
import { wsManager } from "./ws.js";

const cfg = env();
const app = buatApp();

const server = app.listen(cfg.PORT, () => {
  console.info(`[jernih-api] siap di http://localhost:${cfg.PORT}`);
});

wsManager.pasangKeServer(server);

for (const sinyal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinyal, () => {
    console.info(`[jernih-api] ${sinyal} diterima, menutup server…`);
    server.close(() => process.exit(0));
  });
}
