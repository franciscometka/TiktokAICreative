import { describe, expect, it } from "vitest";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { PRICING_TABLE } from "@/config/pricing";
import { costForUsage, estimateSceneVideoCostUsd } from "@/costs/calculate";
import { simplePlan } from "@/test/fixtures";
import { MP4, runwayFixture } from "@/test/runway-fake";

const pricing = PRICING_TABLE.find((p) => p.provider === RUNWAY_VIDEO.provider)!;
describe("Runway sem internet", () => {
  it("envia UM POST, consulta status e baixa sem Authorization; estima duração comprada", async () => {
    const { provider, request, calls } = await runwayFixture();
    expect(provider.estimateCost(request).costUsd).toBe(0.25);
    expect(JSON.stringify(provider)).not.toContain("secret-test-key");
    const ref = await provider.generateScene(request);
    expect(await provider.getStatus(ref)).toMatchObject({ state: "succeeded" });
    const result = await provider.downloadResult(ref);
    expect(result).toMatchObject({ durationSeconds: 5, isMock: false, billedUsage: { seconds: 5 } });
    expect(result.data).toEqual(MP4);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model: RUNWAY_VIDEO.model, ratio: "720:1280", duration: 5 });
    expect(calls[2]!.init?.headers).toBeUndefined();
    expect(costForUsage(pricing, result.billedUsage).costUsd).toBe(0.25);
  });
  it("recusa entradas inválidas antes do POST", async () => {
    const { provider, request, calls } = await runwayFixture();
    for (const invalid of [{ ...request, prompt: "x".repeat(1001) }, { ...request, referenceImageUris: [] }, { ...request, durationSeconds: 11 }]) {
      await expect(provider.generateScene(invalid)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
  it("falha HTTP não repete e não vaza segredo", async () => {
    const { provider, request, calls } = await runwayFixture({ httpError: true });
    await expect(provider.generateScene(request)).rejects.toThrow(/possível cobrança/);
    expect(calls).toHaveLength(1);
  });
  it("preserva consumo se o download falhar depois do sucesso", async () => {
    const { provider, request } = await runwayFixture({ downloadFailure: true });
    const ref = await provider.generateScene(request);
    await provider.getStatus(ref);
    await expect(provider.downloadResult(ref)).rejects.toMatchObject({ providerJobId: "task_1", billedUsage: { seconds: 5 } });
  });
  it("falha reembolsada informa consumo zero", async () => {
    const { provider, request } = await runwayFixture({ failure: true });
    const ref = await provider.generateScene(request);
    expect(await provider.getStatus(ref)).toMatchObject({ state: "failed", billedUsage: { seconds: 0 } });
  });
  it("estimativa da cena arredonda para duração suportada; preço não é placeholder", () => {
    const scene = simplePlan().scenes[0]!;
    expect(estimateSceneVideoCostUsd({ ...scene, estimatedGenerationSeconds: 3 }, pricing)).toBe(0.25);
    expect(estimateSceneVideoCostUsd(scene, pricing)).toBe(0.5);
    expect(pricing.isPlaceholder).toBe(false);
  });
  it("URL de saída fora da CDN é recusada antes do download e mantém custo", async () => {
    const { provider, request, calls } = await runwayFixture({ outputUrl: "https://localhost/private" });
    const ref = await provider.generateScene(request);
    await provider.getStatus(ref);
    await expect(provider.downloadResult(ref)).rejects.toMatchObject({ billedUsage: { seconds: 5 } });
    expect(calls).toHaveLength(2);
  });

});
