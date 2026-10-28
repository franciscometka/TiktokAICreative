import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Lote 7: `npm run test:cloud` — repositórios, fila, API, worker e integração com Postgres REAL
 * em WASM (PGlite). Sem rede externa (mesmo setup no-network) e sem nenhuma API paga.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    setupFiles: ["src/test/no-network.ts"],
    include: ["src/cloud/**/*.test.ts"],
    testTimeout: 45_000,
    // PGlite + migrations no beforeAll.
    hookTimeout: 60_000,
    // Poucos arquivos pesados: em série evita disputa de CPU entre bancos WASM.
    fileParallelism: false,
  },
});
