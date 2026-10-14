import { describe, expect, it } from "vitest";
import { loadAppConfig, readRemotionLicenseKey } from "@/config/env";
import { createRenderer, LazyRemotionRenderer } from "./create-renderer";
import { MockRenderer } from "./renderer";

const OPTIONS = { rendersDir: "outputs/renders", allowedAssetRoots: ["data/uploads"] };

describe("createRenderer (factory central)", () => {
  it("mock → MockRenderer", () => {
    const r = createRenderer("mock", OPTIONS);
    expect(r).toBeInstanceOf(MockRenderer);
    expect(r.isMock).toBe(true);
  });

  it("remotion → renderer real carregado sob demanda (não importa Remotion ao criar)", () => {
    const r = createRenderer("remotion", OPTIONS);
    expect(r).toBeInstanceOf(LazyRemotionRenderer);
    expect(r.id).toBe("remotion");
    expect(r.isMock).toBe(false);
  });

  it("config: RENDERER padrão é mock; valores inválidos são recusados", () => {
    expect(loadAppConfig({}).renderer.id).toBe("mock");
    expect(loadAppConfig({ RENDERER: "remotion" }).renderer.id).toBe("remotion");
    expect(() => loadAppConfig({ RENDERER: "lambda" })).toThrow();
  });
});

describe("config do renderer", () => {
  it("lê pasta, concorrência, debug e navegador; licença só do ambiente", () => {
    const c = loadAppConfig({ RENDERS_DIR: "x/renders", RENDER_CONCURRENCY: "2", RENDER_DEBUG: "true", RENDER_BROWSER_EXECUTABLE: "C:/tools/chrome.exe" });
    expect(c.rendersDir).toBe("x/renders");
    expect(c.renderer).toEqual({ id: "mock", concurrency: 2, debug: true, browserExecutable: "C:/tools/chrome.exe" });
    expect(JSON.stringify(loadAppConfig({ REMOTION_LICENSE_KEY: "rk_123" }))).not.toContain("rk_123");
    expect(readRemotionLicenseKey({ REMOTION_LICENSE_KEY: " rk_123 " })).toBe("rk_123");
    expect(readRemotionLicenseKey({})).toBeNull();
  });
});
