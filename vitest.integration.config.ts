import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Suíte de integração REAL (paga). Só roda com RUN_PAID_TESTS=1 e ANTHROPIC_API_KEY definida. */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
