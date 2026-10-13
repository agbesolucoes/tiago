import { defineConfig } from "vitest/config";

// Testes do servidor Node (Hostinger): rodam no Node de verdade, com SQLite em arquivo temporário.
export default defineConfig({
  test: { include: ["test-node/**/*.test.ts"], environment: "node" },
});
