import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationCost } from "@/domain/cost";
import { cloudHarness, FAKE_SECRETS, type CloudHarness } from "@/test/cloud-harness";
import { OTHER_USER, TEST_USER } from "@/test/pglite";
import { PostgresCostLedger } from "./ledger-repository";

/** L8.2 — GET /v1/credits: derivado de ledger_entries do PRÓPRIO usuário; nada técnico no corpo. */

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

const cost = (id: string, costBrl: number, createdAt = new Date().toISOString(), simulated = false): GenerationCost => ({
  kind: "actual", id, campaignId: "campaign_credits", jobId: "job_credits", creativeId: null, sceneId: null, attemptId: null, llmCallId: null,
  operation: "ugc_video_generation", category: "ugc_scene", description: "Cena UGC", provider: "krea", model: "veo-secret-model-name", unit: "per_second",
  quantity: 8, unitPriceUsd: 0.1, costUsd: 0.8, exchangeRate: 5.5, costBrl, simulated, createdAt,
}) as GenerationCost;

describe("GET /v1/credits", () => {
  it("exige sessão", async () => {
    expect((await h.call("GET", "/v1/credits", { user: null })).status).toBe(401);
  });

  it("sem ledger no mês: saldo = franquia", async () => {
    const res = await h.call("GET", "/v1/credits");
    expect(res.status).toBe(200);
    expect(res.json.value).toMatchObject({ configured: true, allowance: 10_000, used: 0, remaining: 10_000, overage: 0, state: "normal", creditsPerBrl: 100 });
    expect(res.json.value.period.timeZone).toBe("America/Sao_Paulo");
  });

  it("uso real do ledger do usuário (mock e outro usuário não contam); resumo para o shell", async () => {
    await new PostgresCostLedger(h.db, TEST_USER).record(cost("credits-a1", 8.37));
    await new PostgresCostLedger(h.db, TEST_USER).record(cost("credits-a2", 50, undefined, true));
    await new PostgresCostLedger(h.db, OTHER_USER).record(cost("credits-b1", 40));

    const mine = (await h.call("GET", "/v1/credits")).json.value;
    expect(mine).toMatchObject({ used: 837, remaining: 9163, usedBrl: 8.37 });
    expect(mine.usageByService).toEqual([{ id: "video", label: "Vídeo IA", credits: 837, share: 1 }]);
    expect(mine.recent).toHaveLength(1);
    expect(mine.recent[0]).toMatchObject({ projectId: "campaign_credits", name: "Projeto removido", credits: 837 });

    const other = (await h.call("GET", "/v1/credits", { user: "b" })).json.value;
    expect(other.used).toBe(4000);

    const summary = await h.call("GET", "/v1/credits?summary=1");
    expect(Object.keys(summary.json.value).sort()).toEqual(["allowance", "creditsPerBrl", "estimatedVideos", "periodStart", "remaining", "state"]);
    expect(summary.json.value.remaining).toBe(9163);
  });

  it("não expõe provider, modelo, prompt, ids de entrada/job nem segredos", async () => {
    const res = await h.call("GET", "/v1/credits");
    expect(res.text).not.toMatch(/krea|veo-secret-model-name|credits-a1|job_credits|Cena UGC|prompt/i);
    for (const secret of Object.values(FAKE_SECRETS)) expect(res.text).not.toContain(secret);
  });
});
