import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateRenderDir, InvalidRenderPathError, relativeRenderUri, renderDir, renderIdFor } from "./output-paths";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "renders-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("caminhos de render", () => {
  it("nomeia versões v1..v9999", () => {
    expect(renderIdFor(1)).toBe("v1");
    expect(renderIdFor(42)).toBe("v42");
    expect(() => renderIdFor(0)).toThrow(InvalidRenderPathError);
    expect(() => renderIdFor(1.5)).toThrow(InvalidRenderPathError);
    expect(() => renderIdFor(10_000)).toThrow(InvalidRenderPathError);
  });

  it("layout <renders>/<campanha>/<criativo>/<versão>", () => {
    expect(renderDir(root, "campaign_1", "creative_2", "v3")).toBe(resolve(root, "campaign_1", "creative_2", "v3"));
    expect(relativeRenderUri("outputs/renders/", "campaign_1", "creative_2", "v3", "final.mp4")).toBe(
      "outputs/renders/campaign_1/creative_2/v3/final.mp4",
    );
    expect(relativeRenderUri("outputs\\renders", "c", "k", "v1", "manifest.json")).toBe("outputs/renders/c/k/v1/manifest.json");
  });

  it.each([
    ["..", "creative", "v1"],
    ["campaign", "../x", "v1"],
    ["campaign", "creative", "v0"],
    ["campaign", "creative", "../v1"],
    ["camp/aign", "creative", "v1"],
    ["campaign", "creative", "final.mp4"],
    ["", "creative", "v1"],
  ])("recusa IDs inválidos (%s, %s, %s)", (campaignId, creativeId, renderId) => {
    expect(() => renderDir(root, campaignId, creativeId, renderId)).toThrow(InvalidRenderPathError);
  });

  it("nunca sobrescreve: cada alocação cria a próxima versão livre", async () => {
    const a = await allocateRenderDir(root, "campaign_1", "creative_1");
    const b = await allocateRenderDir(root, "campaign_1", "creative_1");
    const c = await allocateRenderDir(root, "campaign_1", "creative_1", 1);
    expect([a.renderId, b.renderId, c.renderId]).toEqual(["v1", "v2", "v3"]);
    expect((await readdir(join(root, "campaign_1", "creative_1"))).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("respeita a versão preferida e pula as ocupadas", async () => {
    const d = await allocateRenderDir(root, "campaign_1", "creative_1", 2);
    expect(d.renderId).toBe("v4");
    const e = await allocateRenderDir(root, "campaign_1", "creative_9", 5);
    expect(e.renderId).toBe("v5");
  });

  it("alocações concorrentes recebem versões distintas", async () => {
    const all = await Promise.all(Array.from({ length: 5 }, () => allocateRenderDir(root, "campaign_c", "creative_c")));
    expect(new Set(all.map((x) => x.renderId)).size).toBe(5);
  });
});
