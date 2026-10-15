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
    await expect(provider.generateScene(request)).rejects.toThrow(/possível cobrança/i);
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


describe("diagnóstico Runway sanitizado", () => {
  it.each([
    [400, "invalid_request"], [422, "invalid_request"], [401, "authentication"],
    [403, "authentication"], [402, "quota"], [429, "quota"], [500, "provider"],
  ])("HTTP %s sem retry", async (status, kind) => {
    const { provider, request, calls } = await runwayFixture({ response: () => Response.json({ error: { code: "quota_or_validation", status: "REJECTED", message: "Useful provider message" } }, { status: Number(status), headers: { "x-request-id": "req-123" } }) });
    const error = await provider.generateScene(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ diagnostic: { kind, httpStatus: status, requestId: "req-123", providerCode: "quota_or_validation", providerStatus: "REJECTED", providerMessage: "Useful provider message", billing: status === 500 ? "unconfirmed" : "rejected" } });
    expect(String(error).includes("Possível cobrança")).toBe(status === 500);
    expect(calls).toHaveLength(1);
  });
  it.each([["TimeoutError", "timeout"], ["AbortError", "timeout"], ["TypeError", "connection"]])("%s sem erro bruto", async (name, kind) => {
    const transportError = new Error("secret-test-key Authorization: private"); transportError.name = name;
    const { provider, request, calls } = await runwayFixture({ transportError });
    const error = await provider.generateScene(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ diagnostic: { kind, billing: "unconfirmed" } });
    expect(String(error)).not.toMatch(/secret-test-key|Authorization|private/);
    expect(calls).toHaveLength(1);
  });
  it.each(["not-json", "{}", '{"id":123}'])("resposta inválida %s mantém HTTP e request-id", async (body) => {
    const { provider, request } = await runwayFixture({ response: () => new Response(body, { headers: { "request-id": "req-invalid" } }) });
    await expect(provider.generateScene(request)).rejects.toMatchObject({ diagnostic: { kind: "invalid_response", httpStatus: 200, requestId: "req-invalid", billing: "unconfirmed" } });
  });
  it("HTTP rejeitado com HTML preserva classificação sem cobrança incerta", async () => {
    const { provider, request } = await runwayFixture({ response: () => new Response("secret-test-key", { status: 401 }) });
    await expect(provider.generateScene(request)).rejects.toMatchObject({ diagnostic: { kind: "authentication", httpStatus: 401, billing: "rejected" } });
  });
  it("redige segredo, Authorization, payload e URLs em todos os campos", async () => {
    const dangerous = 'secret-test-key https://private.test/clip?signature=private data:image/png;base64,PRIVATE Authorization: Bearer other-secret';
    const { provider, request } = await runwayFixture({ response: () => Response.json({ code: dangerous, status: dangerous, message: dangerous, payload: "never persist this", key: "other-secret" }, { status: 400, headers: { "request-id": dangerous } }) });
    const error = await provider.generateScene(request).catch((e: unknown) => e);
    const serialized = String(error) + JSON.stringify(error);
    expect(serialized).not.toMatch(/secret-test-key|Authorization|Bearer|other-secret|signature|PRIVATE|never persist/);
    expect(serialized).toContain("redigido");
  });
});
