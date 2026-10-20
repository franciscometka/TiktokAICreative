import { describe, expect, it } from "vitest";
import { DURATION_TARGETS } from "@/config/duration-targets";
import { GenerationJobSchema } from "@/domain/pipeline";
import { isUgcPersonSource } from "@/domain/ugc";
import { VOICE_LOCK_UNAVAILABLE } from "@/domain/video-speech";
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
import { ugcHarness } from "@/test/ugc-harness";
import { saveAvatar } from "./avatar-actions";
import { getCampaignView } from "./campaign-actions";
import { CREATE_V2_REQUIRED_FIELDS, CreateV2InputSchema, startVideoV2, v2Estimates } from "./create-v2";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { PRICING_TABLE } from "@/config/pricing";

const budget = { maxCostPerCreativeBrl: 200, maxCostPerCampaignBrl: 500, allowOverBudget: false };

async function setup(options: Parameters<typeof ugcHarness>[0] = {}) {
  const h = await ugcHarness(options);
  const { uploads } = await tempUploads();
  const avatars = new InMemoryAvatarLibraryStore();
  const productId = "prod_v2";
  const photo = await uploads.save(productId, { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
  const deps = { service: h.service, uploads, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, avatars, defaultBudget: budget };
  const input = (over: Record<string, unknown> = {}) => ({ productId, name: "Secador de cabelo Pro", imageIds: [photo.id], idea: "Uma mulher apresentando este secador de forma natural em um quarto.", duration: 30, ...over });
  const create = async (over: Record<string, unknown> = {}) => {
    const result = await startVideoV2(deps, input(over));
    if (!result.ok) throw new Error(result.error.message);
    await until(async () => (await h.service.getCampaign(result.value.campaignId)).status === "planned");
    const campaign = await h.service.getCampaign(result.value.campaignId);
    // A estimativa (cálculo puro) é gravada logo depois de o plano ficar pronto.
    await until(async () => (await h.service.getJob(campaign.jobIds[0]!)).estimate !== undefined);
    return { result: result.value, campaign, job: await h.service.getJob(campaign.jobIds[0]!), plan: campaign.plan!.creatives[0]! };
  };
  return { h, deps, avatars, input, create };
}

describe("Create V2 (Lote 6)", () => {
  it("exige poucos campos: foto, nome, ideia e duração (avatar = Automático)", async () => {
    expect(CREATE_V2_REQUIRED_FIELDS).toEqual(["imageIds", "name", "idea", "duration"]);
    const empty = CreateV2InputSchema.safeParse({ productId: "prod_x" });
    expect(empty.success).toBe(false);
    if (!empty.success) expect([...new Set(empty.error.issues.map((i) => String(i.path[0])))].sort()).toEqual(["duration", "idea", "imageIds", "name"]);
    const minimal = CreateV2InputSchema.parse({ productId: "prod_x", name: "Secador", imageIds: ["img_00000000-0000-4000-8000-000000000000.png"], idea: "Natural no quarto", duration: 45 });
    expect(minimal).toMatchObject({ avatar: "auto", style: "ugc_natural" });
    expect(CreateV2InputSchema.safeParse({ ...minimal, duration: 50 }).success).toBe(false);
  });

  it("avatar automático por tag: persiste avatarId + revisão no job; editar o avatar depois não muda o job", async () => {
    const { avatars, deps, create } = await setup();
    const marina = await saveAvatar({ ...deps, avatars }, { name: "Marina", gender: "woman", tags: ["beleza"], defaultForTags: ["cabelo"], personality: "Natural e simpática", voiceProfileId: "voice_clara", defaultEnvironment: "quarto moderno", defaultOutfit: "camiseta branca" });
    expect(marina.ok).toBe(true);
    const { campaign, job, result } = await create();
    expect(result.avatarReason).toContain("Marina");
    expect(campaign.request).toMatchObject({ uxVersion: 2, targetDurationSeconds: 30, avatar: { mode: "auto", avatarRevision: 1, snapshot: { name: "Marina" } } });
    expect(job.avatar).toEqual({ avatarId: campaign.request.avatar!.avatarId, avatarRevision: 1 });
    // Identidade NÃO regenerada do zero: vem da revisão do avatar (aparência, roupa, ambiente, voz).
    expect(job.ugc!.identity).toMatchObject({ source: "library", libraryCharacterId: campaign.request.avatar!.avatarId, avatarRevision: 1, avatarName: "Marina", gender: "woman", wardrobe: "camiseta branca" });
    expect(job.ugc!.identity.environmentDescription).toContain("quarto moderno");
    expect(job.ugc!.identity.voiceDescription).toMatch(/female Brazilian Portuguese voice/);
    expect(campaign.request.speakerProfileId).toBe("clara");

    const id = campaign.request.avatar!.avatarId!;
    const edited = await saveAvatar({ ...deps, avatars }, { id, name: "Marina", gender: "woman", tags: ["beleza"], defaultForTags: ["cabelo"], defaultOutfit: "camisa jeans" });
    expect(edited.ok && edited.value.revision).toBe(2);
    const after = await deps.service.getJob(job.id);
    expect(after.avatar!.avatarRevision).toBe(1);
    expect(after.ugc!.identity.wardrobe).toBe("camiseta branca");
  });

  it("sem avatar compatível: apresentadora sintética, motivo registrado", async () => {
    const { create } = await setup();
    const { campaign, job } = await create();
    expect(campaign.request.avatar).toMatchObject({ mode: "synthetic" });
    expect(job.avatar).toBeUndefined();
    expect(job.ugc!.identity.source).toBe("generated");
  });

  it("master script único → segmentos; mesma persona; CTA no roteiro; Presenter Only continua", async () => {
    const { create } = await setup();
    const { plan } = await create({ personalize: { cta: "Se fizer sentido pra você, confere no carrinho" } });
    const master = plan.masterScript!;
    const arolls = plan.scenes.filter((s) => isUgcPersonSource(s.visualSource));
    expect(plan.scenes.every((s) => s.edit?.role === "aroll")).toBe(true);
    expect(plan.editPlanVersion).toBe(3);
    expect(master.segments).toHaveLength(arolls.length);
    expect(master.segments.map((s) => s.sceneId)).toEqual(arolls.map((s) => s.id));
    expect(arolls.map((s) => s.narration)).toEqual(master.segments.map((s) => s.text));
    expect(master.segments.map((s) => s.text).join(" ")).toBe(master.text);
    expect(plan.script).toBe(master.text);
    expect(new Set(master.segments.map((s) => s.personaId)).size).toBe(1);
    expect(plan.callToAction).toBe("Se fizer sentido pra você, confere no carrinho.");
    expect(master.segments.at(-1)!.text.endsWith(plan.callToAction)).toBe(true);
    expect(plan.scenes.at(-1)!.edit?.finalTail).toBe(true);
  });

  it.each([30, 45, 60] as const)("duração %is define trechos e duração final", async (seconds) => {
    const { create } = await setup();
    const { plan, campaign } = await create({ duration: seconds });
    const target = DURATION_TARGETS[seconds];
    expect(plan.scenes).toHaveLength(target.clips);
    expect(plan.duration).toBeGreaterThanOrEqual(target.finalVideoSeconds.min);
    expect(plan.masterScript!.targetSeconds).toBe(seconds);
    expect(campaign.settings.finalVideoSeconds).toEqual(target.finalVideoSeconds);
  });

  it("Voice Lock: provider com fala nativa → registrado como indisponível (sem fallback silencioso)", async () => {
    const { create } = await setup();
    const { job } = await create();
    expect(job.voiceLock).toMatchObject({ requested: "auto", strategy: "provider_native", available: false });
    expect(job.voiceLock!.reason).toContain(VOICE_LOCK_UNAVAILABLE);
  });

  it("Voice Lock exigido com provider sem lip-sync: recusa clara e nenhum projeto criado", async () => {
    const { deps, input, h } = await setup();
    const before = (await h.service.listCampaignIds()).length;
    const result = await startVideoV2(deps, input({ advanced: { voiceLock: "locked" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.title).toBe("Voice Lock indisponível"); expect(result.error.message).toContain(VOICE_LOCK_UNAVAILABLE); }
    expect((await h.service.listCampaignIds()).length).toBe(before);
  });

  it("Voice Lock com provider de lip-sync: UMA narração mestre dividida por trecho", async () => {
    const { create, h, avatars, deps } = await setup({ strategy: "external_lipsync" });
    await saveAvatar({ ...deps, avatars }, { name: "Lucas", gender: "man", tags: ["cabelo"], voiceProfileId: "voice_lucas" });
    const { job, plan } = await create();
    expect(job.voiceLock).toMatchObject({ strategy: "locked_voice", speech: "external_lipsync", available: true, voiceProfileId: "voice_lucas" });
    const quote = await h.service.quoteJob(job.id);
    expect(quote.ready).toBe(true);
    const first = await (await h.service.authorizeAndRunJob(job.id, quote.token)).completion;
    expect(first.kind).toBe("WAITING_STAGE");
    const waiting = await h.service.getJob(job.id);
    const approved = await h.service.approveUgcReference(job.id, waiting.ugc!.references[0]!.id, { fidelityConfirmed: true });
    await approved.completion;
    const done = await h.service.getJob(job.id);
    expect(h.calls.narrations()).toHaveLength(1); // nunca uma voz por trecho
    expect(done.masterAudio).toBeDefined();
    expect(done.masterAudio!.segments.map((s) => s.sceneId)).toEqual(plan.masterScript!.segments.map((s) => s.sceneId));
    expect(done.masterAudio!.segments[0]!.startSeconds).toBe(0);
    expect(done.masterAudio!.segments.at(-1)!.endSeconds).toBe(done.masterAudio!.durationSeconds);
  });

  it("jobs antigos continuam abrindo (sem uxVersion/avatar/voiceLock)", async () => {
    const { h, deps } = await setup();
    const view = await getCampaignView(deps, h.campaign.id);
    expect(view.ok).toBe(true);
    if (view.ok) { expect(view.value.uxVersion).toBeUndefined(); expect(view.value.creatives[0]!.avatar).toBeUndefined(); }
    const legacy = { ...(await h.service.getJob(h.jobId)) } as Record<string, unknown>;
    delete legacy.avatar; delete legacy.voiceLock; delete legacy.masterAudio;
    expect(GenerationJobSchema.safeParse(legacy).success).toBe(true);
  });

  it("estimativa antes de gerar por duração (mais trechos = mais caro)", () => {
    const table = v2Estimates(new StaticPricingCatalog(PRICING_TABLE), 5.5);
    const high = (d: number) => table.find((e) => e.duration === d && e.quality === "high")!;
    expect(high(30).clips).toBe(5);
    expect(high(45).totalBrl).toBeGreaterThan(high(30).totalBrl);
    expect(high(60).totalBrl).toBeGreaterThan(high(45).totalBrl);
    expect(high(30).lines.map((l) => l.label)).toEqual(["Roteiro", "Apresentadora (imagem de referência)", "Vídeo (5 trechos)", "Finalização"]);
  });
});
