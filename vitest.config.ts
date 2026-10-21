import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Nenhum teste normal acessa a internet (ElevenLabs/Anthropic usam transporte falso).
    setupFiles: ["src/test/no-network.ts"],
    // Pipelines completos (Presenter Only: 5–6 trechos) rodam em paralelo; 5s estourava sob carga.
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "remotion/**/*.test.ts"],
    // Fora da suíte padrão: testes PAGOS (npm run test:integration) e renders reais (npm run test:render).
    // Lote 7: src/cloud (Postgres em WASM) roda em `npm run test:cloud`, sem disputar CPU com os pipelines.
    exclude: ["src/**/*.integration.test.ts", "src/**/*.render.test.ts", "src/cloud/**", "node_modules/**"],
  },
});
