import pino from "pino";
import { env } from "../env.js";

export const log = pino({
  level: env().NODE_ENV === "test" ? "silent" : "info",
  /** Jangan pernah mencetak rahasia ke log — ini sering lolos saat terburu-buru. */
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.body.password',
      "req.body.kataSandi",
      "req.body.kode",
      "*.kodeHash",
      "*.kataSandiHash",
    ],
    censor: "•••",
  },
});
