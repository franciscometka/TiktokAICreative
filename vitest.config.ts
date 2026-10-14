import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Testes que chamam APIs pagas ficam fora da suíte padrão (npm run test:integration).
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
