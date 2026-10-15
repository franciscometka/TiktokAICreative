import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRemotionBrowser } from "./browser-readiness";

describe("diagnóstico local do navegador Remotion", () => {
  it("não baixa nada e orienta a preparação quando ausente", () => {
    const result = detectRemotionBrowser(null, join(tmpdir(), "remotion-browser-ausente"));
    expect(result).toMatchObject({ available: false, source: "missing" });
    expect(result.detail).toContain("npm run render:setup");
  });

  it("aceita somente um executável configurado que exista", async () => {
    const root = await mkdtemp(join(tmpdir(), "remotion-browser-"));
    const executable = join(root, "chrome.exe");
    await writeFile(executable, "fixture");
    expect(detectRemotionBrowser(executable)).toMatchObject({ available: true, source: "configured" });
    expect(detectRemotionBrowser(join(root, "missing.exe")).available).toBe(false);
  });
});
