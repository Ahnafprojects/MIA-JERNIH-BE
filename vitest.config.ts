import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Modul yang menyentuh database tidak boleh jalan bersamaan dan saling
    // menghapus data satu sama lain.
    fileParallelism: false,
  },
});
