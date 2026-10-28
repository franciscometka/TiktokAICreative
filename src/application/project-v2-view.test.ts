import { describe, expect, it } from "vitest";
import { InMemoryAvatarLibraryStore } from "@/storage/avatar-store";
import { PNG_BYTES, tempUploads } from "@/test/app-fixtures";

/** Polling espaçado: no Windows, ler o JSON durante o rename atômico pode dar EPERM. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 75));
  }
}
import { ugcHarness, FULL_REVIEW } from "@/test/ugc-harness";
import { saveAvatar } from "./avatar-actions";
import { getCampaignView } from "./campaign-actions";
import type { CampaignView } from "./campaign-view";
import { startVideoV2 } from "./create-v2";
import { buildProjectV2View, clockLabel, listProjectCards, matchesFilter, PRODUCT_CHECKLIST } from "./project-v2-view";

const budget = { maxCostPerCreativeBrl: 200, maxCostPerCampaignBrl: 500, allowOverBudget: false };

async function v2Project(withAvatar: boolean | "photo", productName = "Secador de cabelo") {
  const h = await ugcHarness();
  const { uploads } = await tempUploads();
  const avatars = new InMemoryAvatarLibraryStore();
  const deps = { service: h.service, uploads, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, avatars, defaultBudget: budget };
  if (withAvatar) {
    const face = withAvatar === "photo" ? await uploads.save("avatar_photos", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" }) : undefined;
    await saveAvatar(deps, { name: "Marina", gender: "woman", tags: ["cabelo"], ...(face ? { referenceImage: { ownerId: "avatar_photos", imageId: face.id } } : {}) });
  }
  const photo = await uploads.save("prod_v2", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
  const started = await startVideoV2(deps, { productId: "prod_v2", name: productName, imageIds: [photo.id], idea: "Natural no quarto", duration: 30 });
  if (!started.ok) throw new Error(started.error.message);
  const campaignId = started.value.campaignId;
  const jobId = async () => (await h.service.getCampaign(campaignId)).jobIds[0]!;
  await until(async () => (await h.service.getCampaign(campaignId)).status === "planned");
  await until(async () => (await h.service.getJob(await jobId())).estimate !== undefined);
  const view = async () => { const r = await getCampaignView(deps, campaignId); if (!r.ok) throw new Error(r.error.message); return r.value; };
  return { h, deps, campaignId, jobId: await jobId(), view };
}

describe("Projeto V2 — geração automática com progresso simples (Lote 6)", () => {
  it("pronto para gerar: estimativa antes do botão e 4 passos de progresso", async () => {
    const { view } = await v2Project(false);
    const v2 = buildProjectV2View(await view());
    expect(v2.phase).toBe("ready_to_generate");
    expect(v2.estimate?.label).toMatch(/^Estimativa: R\$/);
    expect(v2.progress.map((s) => s.label)).toEqual(["Preparando roteiro", "Preparando apresentadora", "Criando vídeo", "Finalizando"]);
    expect(v2.progress[0]!.state).toBe("done");
  });

  it("sintético → \"Esta será sua apresentadora\"; avatar sem foto → revisão honesta da pessoa; avatar COM foto → foto real + \"é a Marina?\"", async () => {
    for (const [withAvatar, phase, title, first] of [
      [false, "presenter_review", "Esta será sua apresentadora", undefined],
      [true, "presenter_review", "Marina (sem foto): confira a apresentadora", undefined],
      ["photo", "product_check", "Confira Marina com o produto", "É Marina: mesmo rosto da foto do avatar"],
    ] as const) {
      const { h, jobId, view } = await v2Project(withAvatar);
      const quote = await h.service.quoteJob(jobId);
      expect((await (await h.service.authorizeAndRunJob(jobId, quote.token)).completion).kind).toBe("WAITING_STAGE");
      const v2 = buildProjectV2View(await view());
      expect(v2.phase).toBe(phase);
      expect(v2.approval).toMatchObject({ title, checklist: [...(first ? [first] : []), ...PRODUCT_CHECKLIST] });
      expect(v2.approval!.avatarPhotoUrl === null).toBe(withAvatar !== "photo");
      // Só afirma "Apresentado por Marina" quando a foto da Marina é usada de fato.
      expect(v2.avatar?.label).toBe(withAvatar === "photo" ? "Apresentado por Marina" : withAvatar ? "Inspirado em Marina (avatar sem foto: aparência pela descrição)" : "Apresentadora gerada automaticamente");
      // Sem estados técnicos na tela principal.
      expect(JSON.stringify({ ...v2.approval, referenceId: undefined })).not.toMatch(/pending|needs_review|approved|ugcref_/);
      const reference = (await h.service.getJob(jobId)).ugc!.references[0]!;
      expect(v2.approval!.referenceId).toBe(reference.id);
      await (await h.service.approveUgcReference(jobId, reference.id, FULL_REVIEW)).completion;
      const after = buildProjectV2View(await view());
      expect(["simulated_done", "done"]).toContain(after.phase);
      expect(after.progress.every((s) => s.state === "done")).toBe(true);
    }
  });

  it("result page: duração 00:36 e custo; erro de trecho com mensagem curta e detalhes recolhidos", async () => {
    const { view } = await v2Project(false);
    const base: CampaignView = await view();
    const creative = base.creatives[0]!;
    const done = buildProjectV2View({ ...base, creatives: [{ ...creative, latestRender: { renderId: "r1", videoUrl: "/api/renders/c/k/r1", downloadUrl: "/api/renders/c/k/r1?download=1", sizeBytes: 1, durationSeconds: 36.2, totalFrames: 1086, renderMs: 1, finishedAt: null, warnings: [] }, actual: { ...(creative.actual ?? { lines: [], entryCount: 1, includesSimulated: false } as never), totalBrl: 12.34 } as never }] });
    expect(done.phase).toBe("done");
    expect(done.headline).toBe("Seu vídeo está pronto");
    expect(done.result).toMatchObject({ durationLabel: "00:36", downloadUrl: "/api/renders/c/k/r1?download=1" });
    expect(done.result!.costLabel).toMatch(/12,34/);

    const scenes = creative.scenes.map((s, i) => (i === 2 ? { ...s, status: "failed" as const, retryQuote: { ready: true, token: "retry_3", estimatedBrl: 2.75 } as never } : s));
    const failed = buildProjectV2View({ ...base, creatives: [{ ...creative, scenes, error: "ProviderError: HTTP 500 {\"zod\":\"...\"}", authorization: { status: "paused" } }] });
    expect(failed.phase).toBe("failed");
    expect(failed.error!.message).toBe("Não conseguimos gerar o trecho 3.");
    expect(failed.headline).not.toContain("ProviderError");
    expect(failed.error!.details).toContain("ProviderError");
    expect(failed.error).toMatchObject({ retry: "scene", sceneId: scenes[2]!.id, sceneToken: "retry_3", sceneEstimatedBrl: 2.75 });
  });

  it("view principal não leva caminhos de disco nem segredos ao browser", async () => {
    const { view } = await v2Project(true);
    const json = JSON.stringify(buildProjectV2View(await view()));
    expect(json).not.toMatch(/[A-Za-z]:\\\\|outputs\/|API_KEY|voiceId/);
  });

  it("detalhes técnicos continuam acessíveis na view completa (cotações por etapa, provider)", async () => {
    const { view } = await v2Project(false);
    const full = await view();
    expect(full.uxVersion).toBe(2);
    expect(full.creatives[0]!.stageQuotes?.length).toBeGreaterThan(0);
    expect(full.creatives[0]!.jobQuote?.stages.length).toBeGreaterThan(0);
    expect(full.creatives[0]!.masterScript?.segments).toBe(5);
    expect(full.creatives[0]!.voiceLock?.strategyLabel).toBe("Voz do próprio vídeo");
  });

  it("regressão L8.4: projeto recém-criado que NUNCA iniciou o planejamento = \"Tudo pronto para começar\", não \"interrompido… pode ter sido cobrado\"", async () => {
    // Modo REAL (sem mocks): o roteiro só roda depois da aprovação explícita. Nenhuma chamada paga
    // acontece aqui — o planner do harness é o mock e nada é aprovado.
    const h = await ugcHarness();
    const service = h.build({ allowMocks: false });
    const { uploads } = await tempUploads();
    const deps = { service, uploads, avatars: new InMemoryAvatarLibraryStore(), rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, defaultBudget: budget };
    const photo = await uploads.save("prod_new", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const started = await startVideoV2(deps, { productId: "prod_new", name: "Secador", imageIds: [photo.id], idea: "Natural no quarto", duration: 30 });
    if (!started.ok) throw new Error(started.error.message);
    const campaign = await service.getCampaign(started.value.campaignId);
    expect(campaign.status).toBe("draft");
    expect(campaign.planningRuns).toBeUndefined();
    const full = await getCampaignView(deps, started.value.campaignId);
    if (!full.ok) throw new Error(full.error.message);
    expect(full.value.planning.runs).toBe(0);
    expect(full.value.error).toBeUndefined();
    const v2 = buildProjectV2View(full.value);
    expect(v2.phase).toBe("planning_approval");
    expect(v2.headline).toBe("Tudo pronto para começar.");
    expect(v2.quoteToken).toBe(full.value.planningQuote!.token);
    expect(JSON.stringify(full.value)).not.toMatch(/pode ter sido cobrad|interrompid/i);
  });

  it("Projetos: cards com nome, avatar, duração e status; filtros simples", async () => {
    const { deps } = await v2Project(true);
    const cards = await listProjectCards(deps);
    const card = cards.find((c) => c.name === "Secador de cabelo")!;
    // L8.6: job criado esperando a autorização da geração = "Aguardando aprovação" (nunca "Rascunho").
    expect(card).toMatchObject({ avatarName: "Marina", durationLabel: "30s", status: "awaiting_approval", statusLabel: "Aguardando aprovação" });
    expect(card.thumbnailUrl).toMatch(/^\/api\/uploads\/prod_v2\//);
    expect(JSON.stringify(card)).not.toMatch(/job_|campaign_.*job|Rascunho/);
    expect(matchesFilter(card, "awaiting_approval")).toBe(true);
    expect(matchesFilter(card, "in_production")).toBe(false);
    expect(matchesFilter(card, "ready")).toBe(false);
    expect(clockLabel(65)).toBe("01:05");
  });
});
