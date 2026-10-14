import { describe, expect, it } from "vitest";
import type { GenerationCost } from "@/domain/cost";
import { InMemoryCostLedger, summarizeActualCosts } from "./ledger";

function cost(over: Partial<GenerationCost>): GenerationCost {
  return {
    kind: "actual",
    id: "cost_1",
    campaignId: "c1",
    jobId: "j1",
    creativeId: "cr1",
    sceneId: "s1",
    attemptId: "a1",
    llmCallId: null,
    operation: "video_generation",
    category: "video",
    description: "teste",
    provider: "mock",
    model: "m",
    unit: "per_second",
    quantity: 1,
    unitPriceUsd: 1,
    costUsd: 1,
    exchangeRate: 5,
    costBrl: 5,
    simulated: true,
    createdAt: "2026-10-13T00:00:00.000Z",
    ...over,
  };
}

describe("InMemoryCostLedger", () => {
  it("é append-only e rejeita IDs duplicados", async () => {
    const ledger = new InMemoryCostLedger();
    await ledger.record(cost({ id: "x" }));
    await expect(ledger.record(cost({ id: "x" }))).rejects.toThrow(/duplicado/);
    expect(ledger).not.toHaveProperty("update");
    expect(ledger).not.toHaveProperty("delete");
  });

  it("valida o registro e filtra por campanha/job (null = nível de campanha)", async () => {
    const ledger = new InMemoryCostLedger();
    await ledger.record(cost({ id: "a" }));
    await ledger.record(cost({ id: "b", jobId: null, category: "llm" }));
    await ledger.record(cost({ id: "c", campaignId: "c2" }));
    expect(await ledger.list({ campaignId: "c1" })).toHaveLength(2);
    expect((await ledger.list({ jobId: null })).map((e) => e.id)).toEqual(["b"]);
    await expect(ledger.record(cost({ id: "d", costBrl: -1 }))).rejects.toThrow();
  });

  it("registros são imutáveis", async () => {
    const ledger = new InMemoryCostLedger();
    await ledger.record(cost({ id: "a" }));
    const [entry] = await ledger.list();
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("summarizeActualCosts — regenerações", () => {
  it("primeira geração R$7 + regeneração R$4 = custo real R$11 (nada escondido)", () => {
    const entries = [
      cost({ id: "1", attemptId: "attempt_1", costBrl: 7, costUsd: 1.4 }),
      cost({ id: "2", attemptId: "attempt_2", costBrl: 4, costUsd: 0.8 }),
    ];
    const summary = summarizeActualCosts(entries, new Set(["attempt_1"]));
    expect(summary.kind).toBe("actual");
    expect(summary.totalBrl).toBe(11);
    expect(summary.discardedBrl).toBe(7);
    expect(summary.keptBrl).toBe(4);
    expect(summary.byCategoryBrl.video).toBe(11);
    expect(summary.entryCount).toBe(2);
    expect(summary.includesSimulated).toBe(true);
  });

  it("soma por categoria e lida com registros sem tentativa", () => {
    const entries = [
      cost({ id: "1", category: "llm", attemptId: null, costBrl: 0.42 }),
      cost({ id: "2", category: "audio", costBrl: 0.08 }),
    ];
    const s = summarizeActualCosts(entries);
    expect(s.byCategoryBrl).toEqual({ llm: 0.42, video: 0, audio: 0.08, rendering: 0 });
    expect(s.totalBrl).toBe(0.5);
    expect(s.discardedBrl).toBe(0);
  });
});
