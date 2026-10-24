// @ts-check
/**
 * Konfigurasi ESLint — sempat tidak ada sama sekali, jadi `npm run lint`
 * selalu gagal dan tidak seorang pun melihat peringatan apa pun.
 *
 * Aturan tambahan di bawah bukan selera, masing-masing menutup satu cara
 * gagal yang sudah pernah terjadi di proyek ini atau yang mahal di backend:
 * `await` yang lupa ditulis, galat yang ditelan diam-diam, dan `any` yang
 * membuat pemeriksaan tipe berhenti bekerja tanpa suara.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "prisma/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Promise yang tidak di-await di route handler membuat galatnya lolos
      // ke luar try/catch dan jatuh sebagai unhandled rejection — prosesnya
      // bisa mati, dan jejaknya tidak menyebut endpoint mana penyebabnya.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Seed dan tes boleh lebih longgar: keduanya tidak melayani permintaan.
    files: ["prisma/seed.ts", "tests/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
