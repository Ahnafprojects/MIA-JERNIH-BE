import { describe, expect, it } from "vitest";
import request from "supertest";
import { buatApp } from "../src/app.js";

describe("GET /health", () => {
  it("membalas ok supaya orkestrator tahu proses ini hidup", async () => {
    const res = await request(buatApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("jernih-api");
  });

  it("endpoint tak dikenal membalas bentuk galat yang seragam", async () => {
    const res = await request(buatApp()).get("/tidak-ada");
    expect(res.status).toBe(404);
    // Bentuk ini adalah kontrak dengan frontend — jangan diubah diam-diam.
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(typeof res.body.error.message).toBe("string");
  });
});
