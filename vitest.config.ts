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
    include: ["src/**/*.test.ts", "remotion/**/*.test.ts"],
    // Fora da suíte padrão: testes PAGOS (npm run test:integration) e renders reais (npm run test:render).
    exclude: ["src/**/*.integration.test.ts", "src/**/*.render.test.ts", "node_modules/**"],
  },
});
