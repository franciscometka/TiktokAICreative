import { describe, expect, it } from "vitest";
import { getCampaignView, authorizeAndRunJob, type AppDeps } from "@/application/campaign-actions";
import { buildGenerationView } from "@/application/generation-view";
import { buildProjectV2View } from "@/application/project-v2-view";
import { LocalUploadStore } from "@/storage/upload-store";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { sourceFixture, v2Fixture } from "@/test/generation-fixtures";
import { ugcHarness } from "@/test/ugc-harness";

/**
 * Cotação → aprovação → autorização, só com transportes falsos (nenhuma chamada paga).
 * Regra: o token é a prova de que o usuário viu ESTA cotação. Cotação pronta e igual autoriza;
 * cotação diferente nunca autoriza sozinha — devolve a nova cotação e exige novo clique.
 */

const BUDGET = { budget: { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false } };

async function realJob() {
  const h = await ugcHarness({ realReference: true, request: BUDGET });
  const strict = h.build({ allowMocks: false });
  await strict.switchJobToReal(h.jobId);
  const deps = { service: strict, uploads: new LocalUploadStore(h.config.uploadsDir), rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, allowMocks: false } as AppDeps;
  const view = async () => {
    const r = await getCampaignView(deps, h.campaign.id);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  /** Nova estimativa do job (preço do provider mudou): outro estimateId e outro valor. */
  const reprice = async (additionalBrl: number) => {
    const store = new FilePipelineStore(h.config.dataDir);
    const job = await store.getJob(h.jobId);
    await store.saveJob({ ...job, estimate: { ...job.estimate!, id: `estimate_repriced_${additionalBrl}`, estimatedAdditionalBrl: additionalBrl } });
  };
  return { ...h, strict, deps, view, reprice };
}

describe("token da cotação do job", () => {
  it("A: mesmo job e mesma cotação → token estável entre chamadas, instâncias e a view", async () => {
    const h = await realJob();
    const first = await h.strict.quoteJob(h.jobId);
    expect(first.ready, first.blocked).toBe(true);
    expect((await h.strict.quoteJob(h.jobId)).token).toBe(first.token);
    expect((await h.build({ allowMocks: false }).quoteJob(h.jobId)).token).toBe(first.token);
    expect((await h.view()).creatives[0]!.jobQuote!.token).toBe(first.token);
  });

  it("causa raiz: antes da estimativa do job a cotação NÃO está pronta e não pode virar token de clique", async () => {
    const h = await realJob();
    const store = new FilePipelineStore(h.config.dataDir);
    const ready = await store.getJob(h.jobId);
    // Janela real do planejamento: o projeto já está "planned" e o job ainda não recebeu a estimativa.
    await store.saveJob({ ...ready, status: "planned", estimate: undefined });
    const early = (await h.view()).creatives[0]!.jobQuote!;
    expect(early.ready).toBe(false);
    const v2Early = buildProjectV2View(await h.view());
    expect(v2Early.quoteToken).toBeNull();

    await store.saveJob(ready);
    const late = (await h.view()).creatives[0]!.jobQuote!;
    expect(late.ready).toBe(true);
    // O token da janela é diferente do token final: clicar com ele só pode gerar "estimativa mudou".
    expect(early.token).not.toBe(late.token);
    expect(buildProjectV2View(await h.view()).quoteToken).toBe(late.token);
  });

  it("B: cotação mudou de verdade → NÃO autoriza, devolve a nova cotação e nada é gerado", async () => {
    const h = await realJob();
    const shown = await h.strict.quoteJob(h.jobId);
    await h.reprice(23); // preço mudou depois que a tela foi aberta

    const refused = await h.strict.authorizeAndRunJob(h.jobId, shown.token).catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "QuoteChangedError" });
    const quote = (refused as { quote: { estimatedBrl: number; maximumAuthorizedBrl: number; token: string } }).quote;
    expect(quote.estimatedBrl).toBeGreaterThan(shown.estimatedBrl);
    expect(quote.token).toHaveLength(64);
    expect(quote.token).not.toBe(shown.token);

    const job = await h.strict.getJob(h.jobId);
    expect(job.jobAuthorization).toBeUndefined();
    expect(job.status).toBe("cost_estimated");
    expect(h.calls.references()).toHaveLength(0);

    // Pela camada de ações (o que a API devolve): erro estruturado com a nova cotação.
    const action = await authorizeAndRunJob(h.deps, { jobId: h.jobId, token: shown.token });
    expect(action).toMatchObject({ ok: false, error: { code: "quote_changed", retryable: true, quote: { token: quote.token } } });
  });

  it("D: token antigo não autoriza a cotação nova, nem depois de a nova ser devolvida", async () => {
    const h = await realJob();
    const old = await h.strict.quoteJob(h.jobId);
    await h.reprice(23);
    await expect(h.strict.authorizeAndRunJob(h.jobId, old.token)).rejects.toMatchObject({ name: "QuoteChangedError" });
    await expect(h.strict.authorizeAndRunJob(h.jobId, old.token)).rejects.toMatchObject({ name: "QuoteChangedError" });
    expect((await h.strict.getJob(h.jobId)).jobAuthorization).toBeUndefined();
    expect(h.calls.references()).toHaveLength(0);
  });

  it("C: o usuário revisa e aprova explicitamente a nova cotação → autoriza com o teto novo", async () => {
    const h = await realJob();
    const old = await h.strict.quoteJob(h.jobId);
    await h.reprice(23);
    const refused = await h.strict.authorizeAndRunJob(h.jobId, old.token).catch((e: unknown) => e) as { quote: { token: string; maximumAuthorizedBrl: number } };
    expect(h.calls.references()).toHaveLength(0);

    // Novo clique, agora com o token da cotação revisada.
    await (await h.strict.authorizeAndRunJob(h.jobId, refused.quote.token)).completion;
    const job = await h.strict.getJob(h.jobId);
    expect(job.jobAuthorization).toMatchObject({ quoteToken: refused.quote.token, maximumAuthorizedBrl: refused.quote.maximumAuthorizedBrl });
    expect(h.calls.references()).toHaveLength(1);
  });

  it("E: dois cliques simultâneos com o mesmo token autorizam uma vez só", async () => {
    const h = await realJob();
    const quote = await h.strict.quoteJob(h.jobId);
    const results = await Promise.allSettled([h.strict.authorizeAndRunJob(h.jobId, quote.token), h.strict.authorizeAndRunJob(h.jobId, quote.token)]);
    for (const r of results) if (r.status === "fulfilled") await r.value.completion;
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(h.calls.references()).toHaveLength(1);
    expect((await h.strict.getJob(h.jobId)).stageApprovals?.filter(a => a.stage === "ugc_reference")).toHaveLength(1);
  });

  it("não há cotação sem estimativa pronta: a tela não habilita 'Gerar vídeo'", () => {
    const notReady = sourceFixture({ jobQuote: { estimatedBrl: 4.84, ready: false }, v2: v2Fixture({ phase: "ready_to_generate", quoteToken: "tok_stale" }) });
    expect(buildGenerationView(notReady, { creditsPerBrl: 100 }).action).toMatchObject({ kind: "authorize", disabled: true });
    const ready = sourceFixture({ jobQuote: { estimatedBrl: 22.44, ready: true }, v2: v2Fixture({ phase: "ready_to_generate", quoteToken: "tok_ok" }) });
    expect(buildGenerationView(ready, { creditsPerBrl: 100 }).action).toMatchObject({ kind: "authorize", disabled: false });
  });
});
