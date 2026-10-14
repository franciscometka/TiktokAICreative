import { describe, expect, it } from "vitest";
import { pricing } from "@/test/fixtures";
import { MockAudioProvider } from "./audio/mock-audio-provider";
import { waitForCompletion } from "./poll";
import { ProviderError } from "./types";
import { MockVideoProvider } from "./video/mock-video-provider";

const noSleep = { intervalMs: 0, sleep: async () => {} };
const request = {
  sceneId: "scene_1",
  prompt: "close up",
  durationSeconds: 4,
  aspectRatio: "9:16" as const,
  referenceImageUris: [],
};

describe("MockVideoProvider", () => {
  it("é explicitamente mock e estima custo pelo preço simulado", () => {
    const p = new MockVideoProvider({ pricing: pricing({ priceUsd: 0.25 }) });
    expect(p.descriptor.isMock).toBe(true);
    const quote = p.estimateCost(request);
    expect(quote).toMatchObject({ kind: "estimate", quantity: 4, costUsd: 1 });
  });

  it("ciclo generate → status → download com polling", async () => {
    const p = new MockVideoProvider({ pricing: pricing(), pollsUntilComplete: 3 });
    const ref = await p.generateScene(request);
    const status = await waitForCompletion((r) => p.getStatus(r), ref, { maxPolls: 5, ...noSleep });
    expect(status.state).toBe("succeeded");
    const result = await p.downloadResult(ref);
    expect(result).toMatchObject({ uri: `mock://video/${ref.providerJobId}.mp4`, isMock: true, durationSeconds: 4 });
    expect(result.billedUsage.seconds).toBe(4);
    expect(p.generateCalls).toHaveLength(1);
  });

  it("polling tem limite rígido (timeout)", async () => {
    const p = new MockVideoProvider({ pricing: pricing(), pollsUntilComplete: 10 });
    const ref = await p.generateScene(request);
    await expect(waitForCompletion((r) => p.getStatus(r), ref, { maxPolls: 2, ...noSleep })).rejects.toThrow(/Timeout/);
  });

  it("falha simulada carrega o consumo faturado quando o provider cobra falhas", async () => {
    const p = new MockVideoProvider({ pricing: pricing(), failSceneIds: new Set(["scene_1"]), billFailures: true });
    const ref = await p.generateScene(request);
    const error = await waitForCompletion((r) => p.getStatus(r), ref, { maxPolls: 2, ...noSleep }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).billedUsage?.seconds).toBe(4);
    await expect(p.downloadResult(ref)).rejects.toThrow(ProviderError);
  });

  it("rejeita requisição inválida e job desconhecido", async () => {
    const p = new MockVideoProvider({ pricing: pricing() });
    await expect(p.generateScene({ ...request, prompt: "  " })).rejects.toThrow(ProviderError);
    await expect(p.getStatus({ providerJobId: "nope" })).rejects.toThrow(ProviderError);
  });

  it("billingMultiplier simula cobrança acima do estimado", async () => {
    const p = new MockVideoProvider({ pricing: pricing(), billingMultiplier: 2 });
    const ref = await p.generateScene(request);
    await p.getStatus(ref);
    expect((await p.downloadResult(ref)).billedUsage.seconds).toBe(8);
  });
});

describe("MockAudioProvider", () => {
  it("gera URI mock e fatura por caracteres", async () => {
    const p = new MockAudioProvider({ pricing: pricing({ unit: "per_1000_characters", priceUsd: 0.1 }) });
    const req = { trackId: "narration", text: "x".repeat(150), language: "pt-BR" as const };
    expect(p.estimateCost(req).costUsd).toBeCloseTo(0.015, 10);
    const ref = await p.generateAudio(req);
    expect((await p.getStatus(ref)).state).toBe("succeeded");
    const result = await p.downloadResult(ref);
    expect(result).toMatchObject({ isMock: true, durationSeconds: 10, mimeType: "audio/mpeg" });
    expect(result.billedUsage.characters).toBe(150);
  });

  it("falha simulada", async () => {
    const p = new MockAudioProvider({ pricing: pricing({ unit: "per_1000_characters" }), fail: true });
    const ref = await p.generateAudio({ trackId: "n", text: "oi", language: "pt-BR" });
    expect((await p.getStatus(ref)).state).toBe("failed");
  });
});
