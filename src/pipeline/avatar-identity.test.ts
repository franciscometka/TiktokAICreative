import { describe, expect, it, vi } from "vitest";
import { MockCreativePlanner, buildMockDraft } from "@/ai/mock-planner";
import { LlmCreativePlanner } from "@/ai/llm-planner";
import type { PlanningRequest } from "@/ai/planner";
import { PROMPTS, ACTIVE_PROMPTS } from "@/ai/prompts/registry";
import { buildUgcReferencePrompt, speechFitsDuration } from "@/ai/ugc-script";
import { saveAvatar } from "@/application/avatar-actions";
import { startVideoV2 } from "@/application/create-v2";
import { planningErrorDetails } from "@/application/user-errors";
import { executeHybridPlanning, getCampaignView } from "@/application/campaign-actions";
import { buildProjectV2View } from "@/application/project-v2-view";
import { loadAppConfig } from "@/config/env";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { avatarSnapshot, type Avatar } from "@/domain/avatar";
import { deriveFidelityConstraints, exactSpecs, fidelityPromptLines } from "@/domain/fidelity";
import { AVATAR_IDENTITY_UNSUPPORTED, isUgcPersonSource } from "@/domain/ugc";
import { randomId } from "@/lib/ids";
import { createUgcProviderFactories } from "@/providers/ugc";
import { buildKreaReferenceBody } from "@/providers/ugc/krea-ugc-providers";
import { MockUgcReferenceProvider, MockUgcVideoProvider } from "@/providers/ugc/mock-ugc-providers";
import { InMemoryAvatarLibraryStore } from "@/storage/avatar-store";
import { PNG_BYTES, tempUploads } from "@/test/app-fixtures";
import { ScriptedLlm, response } from "@/test/fake-llm";
import { product } from "@/test/fixtures";
import { PNG_1X1 } from "@/test/google-fake";
import { FAKE_KREA_KEY, kreaFake } from "@/test/krea-fake";
import { ugcHarness } from "@/test/ugc-harness";
import { identityBlockReason } from "./ugc-flow";

/*
 * Correção do Lote 6 — avatar salvo nunca vira outra pessoa; fidelidade de especificações;
 * "Não conseguimos preparar o roteiro" reproduzido e corrigido. Tudo offline (zero rede/paga).
 */

const SECADOR = "Secador de Cabelos Profissional Color Wind Santa Clara 2100W 220V";
const budget = { maxCostPerCreativeBrl: 200, maxCostPerCampaignBrl: 500, allowOverBudget: false };

const cristina: Avatar = {
  id: "avatar_cristina", revision: 3, name: "Cristina", active: true, gender: "woman", appearanceDescriptors: "", visualAgeRange: "30s", hair: "cabelo castanho",
  appearancePrompt: "", defaultOutfit: "blusa branca", defaultEnvironment: "", speakingStyle: "", personality: "Natural e simpática", tags: [], preferredProductCategories: [],
  defaultForTags: [], archived: false, createdAt: "t", updatedAt: "t",
  referenceImage: { ownerId: "avatar_photos", imageId: "img_00000000-0000-4000-8000-0000000000aa.png", uri: "outputs/uploads/avatar_photos/img_00000000-0000-4000-8000-0000000000aa.png" },
};
const selection = (avatar: Avatar) => ({ mode: "manual" as const, avatarId: avatar.id, avatarRevision: avatar.revision, reason: `${avatar.name} escolhido por você.`, matchedTags: [], snapshot: avatarSnapshot(avatar) });

describe("avatar salvo ≠ pessoa sintética (identidade)", () => {
  it("identidade do avatar com foto: estratégia avatar_reference_image + asset da foto; o prompt pede A MESMA pessoa", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "auto", environment: "auto", visualStyle: "natural_smartphone" }, avatar: avatarSnapshot(cristina) });
    expect(identity).toMatchObject({ source: "library", identityStrategy: "avatar_reference_image", avatarReferenceAsset: cristina.referenceImage, avatarName: "Cristina", avatarRevision: 3 });
    const prompt = buildUgcReferencePrompt(identity, productAnchor(product())!);
    expect(prompt).toMatch(/exactly the presenter from the supplied avatar photo/);
    expect(prompt).not.toMatch(/Fictional synthetic/);
    const synthetic = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "woman", environment: "auto", visualStyle: "natural_smartphone" } });
    expect(synthetic.identityStrategy).toBe("synthetic");
    expect(buildUgcReferencePrompt(synthetic, productAnchor(product())!)).toMatch(/Fictional synthetic adult person/);
    const noPhoto = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "auto", environment: "auto", visualStyle: "natural_smartphone" }, avatar: avatarSnapshot({ ...cristina, referenceImage: undefined }) });
    expect(noPhoto.identityStrategy).toBe("avatar_description");
  });

  it("Krea (Nano Banana 2): produto + foto do avatar em image_urls; sem a foto enviada, nenhum corpo é montado", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "auto", environment: "auto", visualStyle: "natural_smartphone" }, avatar: avatarSnapshot(cristina) });
    const request = { product: productAnchor(product())!, identity, prompt: "p", aspectRatio: "9:16" as const, identityImage: { uri: cristina.referenceImage!.uri } };
    const body = buildKreaReferenceBody(request, "https://gen.krea.ai/product.png", "https://gen.krea.ai/avatar.png");
    expect(body.image_urls).toEqual(["https://gen.krea.ai/product.png", "https://gen.krea.ai/avatar.png"]);
    expect(body.prompt).toMatch(/Image 2 is the presenter: keep exactly the same person/);
    expect(body.prompt).not.toMatch(/must be synthetic/);
    expect(() => buildKreaReferenceBody(request, "https://gen.krea.ai/product.png")).toThrow(/nenhuma pessoa nova/);
  });

  it("pipeline Krea (fetch falso): a foto do avatar é enviada (2 assets, 2 image_urls) e gravada na referência e no job", async () => {
    const env = { KREA_API_KEY: FAKE_KREA_KEY, UGC_PROVIDER: "krea", UGC_REAL_ALLOWED: "true" };
    const fake = kreaFake();
    const loaded: string[] = [];
    const ugcProviders = createUgcProviderFactories({ krea: {
      apiKey: FAKE_KREA_KEY, readiness: kreaUgcReadiness(loadAppConfig(env), env), transport: fake.fetch,
      loadImage: async (uri) => { loaded.push(uri); return { data: new Uint8Array(PNG_1X1), mimeType: "image/png" }; },
    } });
    const h = await ugcHarness({ modes: { ugc_reference: "real", ugc_video: "real" }, ugcProviders, deps: { ugcChoice: kreaUgcPricingRefs }, request: { budget: { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false }, avatar: selection(cristina) } });
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const job = await h.service.getJob(h.jobId);
    expect(job.avatar).toEqual({ avatarId: "avatar_cristina", avatarRevision: 3, identityStrategy: "avatar_reference_image", avatarReferenceAsset: cristina.referenceImage });
    const reference = job.ugc!.references.at(-1)!;
    expect(reference).toMatchObject({ identityStrategy: "avatar_reference_image", avatarReferenceAsset: cristina.referenceImage });
    expect(loaded).toContain(cristina.referenceImage!.uri);
    expect(fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/assets"))).toHaveLength(2);
    const post = fake.calls.find((c) => c.method === "POST" && c.url.includes("/generate/image/"))!;
    expect(post.body!.image_urls).toHaveLength(2);
    expect(String(post.body!.prompt)).toMatch(/exactly the presenter from the supplied avatar photo/);
    expect(String(post.body!.prompt)).not.toMatch(/Fictional synthetic|must be synthetic/);
  });

  it("provider SEM referência de identidade: projeto com avatar com foto é recusado ANTES de criar campanha (nem o roteiro é pago)", async () => {
    const references: MockUgcReferenceProvider[] = [];
    const h = await ugcHarness({ ugcProviders: {
      reference: (pricing) => { const p = new MockUgcReferenceProvider(pricing, { identityReference: false }); references.push(p); return p; },
      video: (pricing) => new MockUgcVideoProvider(pricing),
    } });
    const before = await h.service.listCampaignIds();
    const { uploads } = await tempUploads();
    const avatars = new InMemoryAvatarLibraryStore();
    const deps = { service: h.service, uploads, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, avatars, defaultBudget: budget };
    const face = await uploads.save("avatar_photos", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const saved = await saveAvatar(deps, { name: "Cristina", gender: "woman", referenceImage: { ownerId: "avatar_photos", imageId: face.id } });
    if (!saved.ok) throw new Error(saved.error.message);
    const photo = await uploads.save("prod_v2", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const planSpy = vi.spyOn(MockCreativePlanner.prototype, "plan");
    const result = await startVideoV2(deps, { productId: "prod_v2", name: SECADOR, imageIds: [photo.id], idea: "Cristina apresentando", duration: 30, avatar: saved.value.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe(AVATAR_IDENTITY_UNSUPPORTED);
    expect(planSpy).not.toHaveBeenCalled();
    expect(await h.service.listCampaignIds()).toEqual(before);
    expect(references.flatMap((p) => p.calls)).toHaveLength(0);
    planSpy.mockRestore();
  });

  it("gate da etapa: identidade com foto + provider sem suporte = motivo de bloqueio (sem fallback sintético)", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "auto", environment: "auto", visualStyle: "natural_smartphone" }, avatar: avatarSnapshot(cristina) });
    expect(identityBlockReason(identity, { supportsIdentityReference: false })).toBe(AVATAR_IDENTITY_UNSUPPORTED);
    expect(identityBlockReason(identity, {})).toBe(AVATAR_IDENTITY_UNSUPPORTED);
    expect(identityBlockReason(identity, { supportsIdentityReference: true })).toBeUndefined();
    const synthetic = resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "woman", environment: "auto", visualStyle: "natural_smartphone" } });
    expect(identityBlockReason(synthetic, { supportsIdentityReference: false })).toBeUndefined();
  });

  it("job antigo (avatar com foto, sem identityStrategy gravado) também não cai em pessoa sintética", () => {
    const legacy = { ...resolveUgcIdentity({ id: "c", revision: 1, product: product(), request: { presenter: "auto", environment: "auto", visualStyle: "natural_smartphone" }, avatar: avatarSnapshot(cristina) }), identityStrategy: undefined, avatarReferenceAsset: undefined };
    expect(identityBlockReason(legacy, { supportsIdentityReference: false })).toBe(AVATAR_IDENTITY_UNSUPPORTED);
  });
});

describe("fidelidade do produto — 2100W", () => {
  const secador = product({ name: SECADOR, description: `${SECADOR} — informações detalhadas não fornecidas.`, features: [], benefits: [] });

  it("especificações vêm do nome; o prompt trata a foto como fonte de verdade e proíbe mudar a potência", () => {
    const constraints = deriveFidelityConstraints(secador);
    expect(exactSpecs(constraints)).toEqual(expect.arrayContaining(["2100W", "220V"]));
    const lines = fidelityPromptLines(constraints).join(" ");
    expect(lines).toMatch(/"2100W", "220V"/);
    expect(lines).toMatch(/never change the power, voltage/);
    expect(lines).toMatch(/copy them, never rewrite them/);
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: secador, request: { presenter: "woman", environment: "auto", visualStyle: "natural_smartphone" } });
    const prompt = buildUgcReferencePrompt(identity, productAnchor({ ...secador, images: [{ id: "img_1", uri: "outputs/uploads/p/img_1.png" }] })!, fidelityPromptLines(constraints));
    expect(prompt).toMatch(/original product photo is the single source of truth/);
    expect(prompt).toMatch(/do not print it as new text/);
  });

  it("aprovar sem conferir 2100W e 220V é recusado; com a conferência explícita, aprova", async () => {
    const h = await ugcHarness({ request: { product: { ...secador, images: product().images } } });
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const reference = (await h.service.getJob(h.jobId)).ugc!.references.at(-1)!;
    await expect(h.service.approveUgcReference(h.jobId, reference.id, { fidelityConfirmed: true })).rejects.toThrow(/2100W, 220V/);
    await expect(h.service.approveUgcReference(h.jobId, reference.id, { fidelityConfirmed: true, confirmedSpecs: ["2100W"] })).rejects.toThrow(/220V/);
    expect((await h.service.getJob(h.jobId)).ugc!.references.at(-1)!.review).toBe("pending");
    await h.service.approveUgcReference(h.jobId, reference.id, { fidelityConfirmed: true, confirmedSpecs: ["2100W", "220V"] });
    expect((await h.service.getJob(h.jobId)).ugc!.references.at(-1)).toMatchObject({ review: "approved", fidelity: { status: "approved", confirmedSpecs: ["2100W", "220V"] } });
  });
});

describe("\"Não conseguimos preparar o roteiro\" — Secador 2100W, Cristina, 30s, Presenter Only", () => {
  it("retomada REAL usa nova cotação, não o handler legado que rejeita a UX V2", async () => {
    const h = await ugcHarness();
    const service = h.build({ allowMocks: false });
    const { uploads } = await tempUploads();
    const avatars = new InMemoryAvatarLibraryStore();
    const deps = { service, uploads, avatars, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, defaultBudget: budget };
    const face = await uploads.save("avatar_photos", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const saved = await saveAvatar(deps, { name: "Cristina", gender: "woman", personality: "Natural e simpática", referenceImage: { ownerId: "avatar_photos", imageId: face.id } });
    if (!saved.ok) throw new Error(saved.error.message);
    const photo = await uploads.save("prod_v2", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const started = await startVideoV2(deps, { productId: "prod_v2", name: SECADOR, imageIds: [photo.id], idea: "Cristina apresentando o secador no quarto", duration: 30, avatar: saved.value.id });
    if (!started.ok) throw new Error(started.error.message);
    const id = started.value.campaignId;
    // A primeira execução falha na validação; a retomada recebe JSON equivalente ao caso real.
    const spy = vi.spyOn(MockCreativePlanner.prototype, "plan").mockImplementationOnce(async (req) => {
      return new LlmCreativePlanner(new ScriptedLlm([response("{}")]), randomId, { maxValidationAttempts: 1 }).plan(req);
    }).mockImplementation(async function (req) {
      return new LlmCreativePlanner(new ScriptedLlm([response(JSON.stringify(buildMockDraft(req)))]), randomId, { maxValidationAttempts: 1 }).plan(req);
    });
    try {
      const first = await service.executePlanning(id, (await service.quotePlanning(id)).token);
      expect((await first.completion).status).toBe("failed");
      await expect(service.retryPlanning(id)).rejects.toThrow("Use a aprovação explícita da etapa de planejamento.");
      const full = await getCampaignView(deps, id);
      if (!full.ok) throw new Error(full.error.message);
      const view = buildProjectV2View(full.value);
      expect(view.error?.retry).toBe("planning_approval");
      expect(view.quoteToken).toBe(full.value.planningQuote!.token);
      expect(view.estimate?.brl).toBe(full.value.planningQuote!.estimatedBrl);
      expect(view.error?.details).toContain("schema");
      const blocked = buildProjectV2View({ ...full.value, planningQuote: { ...full.value.planningQuote!, ready: false, blocked: "Limite de tentativas de planejamento atingido" } });
      expect(blocked.error?.retry).toBe("planning_approval");
      expect(blocked.quoteToken).toBeNull();
      expect(blocked.error?.details).toContain("Limite de tentativas");
      const interrupted = buildProjectV2View({ ...full.value, state: "interrupted" });
      expect(interrupted.error?.retry).toBe("planning_approval");
      expect(interrupted.quoteToken).toBe(view.quoteToken);
      const resumed = await executeHybridPlanning(deps, { campaignId: id, token: view.quoteToken! });
      expect(resumed.ok).toBe(true);
      const deadline = Date.now() + 10_000;
      while (service.isPlanningActive(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const campaign = await service.getCampaign(id);
      expect(campaign.status).toBe("planned");
      expect(campaign.plan!.creatives[0]!.masterScript!.persona.avatarName).toBe("Cristina");
      expect(campaign.plan!.creatives[0]!.scenes).toHaveLength(5);
      expect(campaign.planningRuns).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
  async function createWithClaude(responses: number) {
    const requests: PlanningRequest[] = [];
    const llms: ScriptedLlm[] = [];
    vi.spyOn(MockCreativePlanner.prototype, "plan").mockImplementation(async (req: PlanningRequest) => {
      requests.push(req);
      // "Claude" devolve um rascunho plausível: o nome completo do produto numa fala de 6,6s.
      const llm = new ScriptedLlm(Array.from({ length: responses }, () => response(JSON.stringify(buildMockDraft(req)))));
      llms.push(llm);
      return new LlmCreativePlanner(llm, randomId, { maxValidationAttempts: 2 }).plan(req);
    });
    const h = await ugcHarness();
    const { uploads } = await tempUploads();
    const avatars = new InMemoryAvatarLibraryStore();
    const deps = { service: h.service, uploads, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, avatars, defaultBudget: budget };
    const face = await uploads.save("avatar_photos", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const saved = await saveAvatar(deps, { name: "Cristina", gender: "woman", personality: "Natural e simpática", referenceImage: { ownerId: "avatar_photos", imageId: face.id } });
    if (!saved.ok) throw new Error(saved.error.message);
    requests.length = 0; llms.length = 0;
    const photo = await uploads.save("prod_v2", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const started = await startVideoV2(deps, { productId: "prod_v2", name: SECADOR, imageIds: [photo.id], idea: "Cristina apresentando o secador", duration: 30, avatar: saved.value.id });
    if (!started.ok) throw new Error(started.error.message);
    const deadline = Date.now() + 10_000;
    while ((await h.service.getCampaign(started.value.campaignId)).status === "planning" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    vi.restoreAllMocks();
    return { campaign: await h.service.getCampaign(started.value.campaignId), request: requests[0]!, llm: llms[0]! };
  }

  it("causa: na 1.8.0 a fala com o nome completo estoura o limite POR TRECHO (18 palavras em 6,6s)", async () => {
    const { request } = await createWithClaude(1);
    // Rascunho no formato observado no Lote 6: trechos de 6,6s e o nome completo numa fala só.
    const mock = buildMockDraft(request);
    const creative = mock.creatives[0]!;
    const scenes = creative.scenes.map((s, i) => ({ ...s, duration: 6.6, estimatedGenerationSeconds: 6.6, ...(i === 1 ? { narration: `Esse é o ${SECADOR}. Deixa eu mostrar ele de pertinho pra vocês.` } : {}) }));
    const draft = { ...mock, creatives: [{ ...creative, scenes, duration: 33, script: scenes.map((s) => s.narration).join(" ") }] };
    const old = PROMPTS.campaignPlan["1.8.0"].validationSchemaFor(request).safeParse(draft);
    expect(old.success).toBe(false);
    if (!old.success) expect(old.error.issues.map((i) => i.message)).toContain("Fala longa demais para 6.6s (máx. 18 palavras).");
  });

  it("1.8.1: re-divisão determinística antes da validação — UMA chamada, sem reparo por LLM, plano com 5 trechos que cabem", async () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.9.0");
    const { campaign, llm } = await createWithClaude(1);
    expect(campaign.status).toBe("planned");
    expect(llm.requests).toHaveLength(1);
    const creative = campaign.plan!.creatives[0]!;
    const arolls = creative.scenes.filter((s) => isUgcPersonSource(s.visualSource));
    expect(arolls).toHaveLength(5);
    for (const scene of arolls) {
      expect(scene.duration).toBeLessThanOrEqual(8);
      expect(speechFitsDuration(scene.narration, scene.duration)).toBe(true);
    }
    expect(creative.masterScript!.segments.at(-1)!.containsCta).toBe(true);
    expect(creative.masterScript!.persona).toMatchObject({ avatarName: "Cristina" });
    expect(creative.duration).toBeGreaterThanOrEqual(30);
  });

  it("\"Ver detalhes\": causa real sanitizada (trecho e motivo), sem segredos nem caminhos", () => {
    const raw = "O Claude não produziu um plano válido dentro do limite de tentativas: A resposta não segue as regras do schema:\n- creatives.0.scenes.1: Fala longa demais para 6.6s (máx. 18 palavras).\nchave sk-ant-api03-abcdefghijklmnop em C:\\Users\\franc\\data\\x.json";
    const details = planningErrorDetails(raw)!;
    expect(details).toContain("Trecho 2: Fala longa demais para 6.6s (máx. 18 palavras).");
    expect(details).not.toMatch(/sk-ant|C:\\Users|creatives\.0/);
  });
});
