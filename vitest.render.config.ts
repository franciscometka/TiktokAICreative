import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Renders REAIS com Remotion (lentos). Rodar com: npm run test:render */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.render.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
