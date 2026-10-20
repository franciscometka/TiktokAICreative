import { describe, expect, it } from "vitest";
import { buildMockDraft } from "@/ai/mock-planner";
import { fitSpeech } from "@/ai/mock-ugc-planner";
import { PRICING_TABLE } from "@/config/pricing";
import { SIMPLE_UGC_QUALITY_PRESETS } from "@/config/simple-presets";
import { ugcVeoPreset } from "@/config/ugc-models";
import { productAnchor, resolveUgcIdentity, suggestEnvironment } from "@/config/ugc";
import { UGC_EDITORIAL_PLANS } from "@/config/edit-policy";
import { applyUgcEditorial } from "./ugc-editorial";
import { campaignPlanPromptV1_6_0 } from "./prompts/campaign-plan.v1_6_0";
import { estimateCreativeCost, resolvePricing } from "@/costs/calculate";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { hydrateCampaignPlan } from "@/ai/hydrate";
import { isUgcPersonSource, UgcCharacterProfileSchema } from "@/domain/ugc";
import { buildRenderManifest } from "@/render/manifest";
import { buildGoogleUgcReferenceRequest, buildVeoUgcVideoRequest } from "@/providers/ugc/google-ugc-contract";
import { product } from "@/test/fixtures";
import { buildUgcReferencePrompt, findUgcSpeechViolations, speechFitsDuration, validateUgcScenes } from "./ugc-script";
import { campaignPlanPromptV1_5_0 } from "./prompts/campaign-plan.v1_5_0";
import { ACTIVE_PROMPTS } from "./prompts/registry";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const p = product();

function ugcPlan(quality: "economy" | "high" | "premium", strategy: "native_speech" | "external_lipsync" = "native_speech") {
  const draft = buildMockDraft({ product: p, styles: ["ugc"], creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS[quality], creativeMode: "ai_ugc", ugcAudioStrategy: strategy });
  let n = 0;
  const hydrated = hydrateCampaignPlan(draft, p, (prefix) => `${prefix}_${++n}`).creatives[0]!;
  // Editor V2: o pipeline aplica o editorial (A-roll espinha + B-roll overlay) depois do planner.
  return { draft, plan: applyUgcEditorial(hydrated, { quality, finalRange: SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds }).plan };
}

describe("roteiro AI UGC", () => {
  it.each([
    ["Uso há meses e adoro.", true],
    ["Eu testei e funcionou comigo.", true],
    ["Comprei ontem.", true],
    ["Conheça este incrível produto!", true],
    ["Olha isso aqui: repara no acabamento.", false],
    ["Esse modelo chama atenção pelo formato.", false],
  ])("%s → proibido=%s", (text, forbidden) => {
    expect(findUgcSpeechViolations(text).length > 0).toBe(forbidden);
  });

  it("fala precisa caber na duração (≤ 2,8 palavras/s); fitSpeech corta sem inventar", () => {
    expect(speechFitsDuration("uma duas três quatro cinco", 2)).toBe(true);
    expect(speechFitsDuration("uma duas três quatro cinco seis sete", 2)).toBe(false);
    expect(fitSpeech("a b c d e f g h i j", 2).split(" ").length).toBeLessThanOrEqual(5);
  });

  it.each(["economy", "high", "premium"] as const)("mock %s: estrutura, fala natural e duração válidas", (quality) => {
    const { draft } = ugcPlan(quality);
    const scenes = draft.creatives[0]!.scenes;
    expect(validateUgcScenes(scenes, "native_speech")).toEqual([]);
    const entries = UGC_EDITORIAL_PLANS[quality];
    expect(scenes.map((s) => s.visualSource)).toEqual(entries.map((e) => (e.role === "aroll" ? e.source : "reference_detail")));
    // Duração final = soma dos A-rolls (B-roll é overlay sobre o áudio).
    const duration = ugcPlan(quality).plan.duration;
    expect(duration).toBeGreaterThanOrEqual(SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds.min);
    expect(duration).toBeLessThanOrEqual(SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds.max);
    for (const s of scenes) expect(findUgcSpeechViolations(s.narration)).toEqual([]);
  });

  it("presets V2: 2/3/4 A-rolls e 1/2/3 B-rolls de detalhe (sem catálogo, sem custo extra)", () => {
    const count = (q: "economy" | "high" | "premium", role: "aroll" | "broll") => UGC_EDITORIAL_PLANS[q].filter((e) => e.role === role).length;
    expect([count("economy", "aroll"), count("high", "aroll"), count("premium", "aroll")]).toEqual([2, 3, 4]);
    expect([count("economy", "broll"), count("high", "broll"), count("premium", "broll")]).toEqual([1, 2, 3]);
    for (const q of ["economy", "high", "premium"] as const) expect(UGC_EDITORIAL_PLANS[q].every((e) => e.role === "aroll" ? e.seconds <= 8 : e.kind === "reference_detail")).toBe(true);
  });

  it("B-roll nunca tem fala própria (fica sobre o áudio do A-roll), em qualquer estratégia", () => {
    expect(ugcPlan("high").draft.creatives[0]!.scenes.filter((s) => !isUgcPersonSource(s.visualSource)).every((s) => !s.narration)).toBe(true);
    const lipsync = ugcPlan("high", "external_lipsync").draft.creatives[0]!.scenes;
    expect(lipsync.filter((s) => !isUgcPersonSource(s.visualSource)).every((s) => !s.narration)).toBe(true);
    expect(validateUgcScenes([{ ...lipsync[0]!, visualSource: "product_image", requiresGeneratedVideo: false, estimatedGenerationSeconds: 0, generationPrompt: "" }, ...lipsync.slice(1)], "native_speech").length).toBeGreaterThan(0);
  });
});

describe("custos AI UGC", () => {
  it("uma referência, cenas UGC e B-roll em categorias próprias; sem TTS com fala nativa", () => {
    const { plan } = ugcPlan("high");
    const pricing = resolvePricing(SIMPLE_UGC_QUALITY_PRESETS.high, catalog);
    const estimate = estimateCreativeCost({ id: "e", plan, settings: SIMPLE_UGC_QUALITY_PRESETS.high, pricing, incurred: { llmCost: { usd: 0, brl: 0 }, ledgerEntryIds: [], sharedAmongCreatives: 1, simulated: true }, exchangeRate: 5, createdAt: "t", nativeUgcSpeech: true });
    const cats = estimate.breakdown.map((l) => l.category);
    expect(cats.filter((c) => c === "ugc_reference")).toHaveLength(1);
    expect(cats.filter((c) => c === "ugc_scene")).toHaveLength(3);
    // B-roll de detalhe vem do frame de referência: nenhuma linha paga de B-roll.
    expect(cats).not.toContain("broll");
    expect(cats).not.toContain("audio");
    expect(estimate.ugcSceneCost!.usd).toBeGreaterThan(0);
    const withVoice = estimateCreativeCost({ id: "e2", plan: ugcPlan("high", "external_lipsync").plan, settings: SIMPLE_UGC_QUALITY_PRESETS.high, pricing, incurred: { llmCost: { usd: 0, brl: 0 }, ledgerEntryIds: [], sharedAmongCreatives: 1, simulated: true }, exchangeRate: 5, createdAt: "t" });
    expect(withVoice.breakdown.some((l) => l.category === "audio")).toBe(true);
  });
});

describe("identidade, produto e biblioteca futura", () => {
  it("auto é determinístico; ambiente sugerido pelo produto; produto-âncora preserva forma/cor/logo", () => {
    const req = { presenter: "auto" as const, environment: "auto" as const, visualStyle: "natural_smartphone" as const };
    const a = resolveUgcIdentity({ id: "c1", revision: 1, product: p, request: req });
    const b = resolveUgcIdentity({ id: "c1", revision: 1, product: p, request: req });
    expect(a).toEqual(b);
    expect(suggestEnvironment({ name: "Furadeira 500W", description: "" })).toBe("workshop");
    expect(suggestEnvironment({ name: "Objeto", description: "genérico" })).toBe("living_room");
    expect(productAnchor(p)!.preserve.join(" ")).toMatch(/shape.*colors.*logo/);
    const prompt = buildUgcReferencePrompt(a, productAnchor(p)!);
    expect(prompt).toMatch(/9:16/);
    expect(prompt).toMatch(/not a celebrity/);
  });

  it("perfil de personagem reutilizável: só estrutura, tags livres, sem nichos fixos", () => {
    const profile = UgcCharacterProfileSchema.parse({ id: "ch1", displayName: "Ana", gender: "woman", ageRange: "30s", appearance: "x", defaultWardrobe: "y", tags: ["qualquer-coisa"], createdAt: "t" });
    expect(profile.imageConsent).toBe(false);
  });
});

describe("prompt campaign-plan@1.5.0 / 1.6.x", () => {
  const input = { product: p, styles: ["ugc"] as const, creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS.high };
  it("1.6.1 é o ativo, mantém o Editor V2 e explicita os campos derivados", () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.6.1");
    expect(campaignPlanPromptV1_6_0.system).toMatch(/uso há meses/);
    expect(campaignPlanPromptV1_6_0.system).toMatch(/A-ROLL/);
    expect(campaignPlanPromptV1_6_0.system).toMatch(/reference_detail/);
    expect(campaignPlanPromptV1_6_0.system).toMatch(/fundo branco/);
    expect(ACTIVE_PROMPTS.campaignPlan.system).toMatch(/requiresGeneratedVideo=true para/);
    expect(campaignPlanPromptV1_5_0.system).toMatch(/uso há meses/);
    expect(campaignPlanPromptV1_5_0.buildUserMessage({ ...input, styles: [...input.styles], creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" })).toMatch(/creativeMode=ai_ugc/);
  });

  it("standard recusa cenas UGC; ai_ugc aceita o plano mock e recusa fala inventada", () => {
    const { draft } = ugcPlan("high");
    const fakeHooks = Array.from({ length: 5 }, (_, i) => ({ text: `Hook ${i}`, angle: "a", style: "ugc" as const }));
    const full = { ...draft, hooks: fakeHooks };
    expect(campaignPlanPromptV1_5_0.validationSchemaFor({ ...input, styles: ["ugc"], creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" }).safeParse(full).success).toBe(true);
    expect(campaignPlanPromptV1_5_0.validationSchemaFor({ ...input, styles: ["ugc"] }).safeParse(full).success).toBe(false);
    const lying = { ...full, creatives: [{ ...full.creatives[0]!, scenes: full.creatives[0]!.scenes.map((s, i) => (i === 0 ? { ...s, narration: "Testei por uma semana." } : s)) }] };
    expect(campaignPlanPromptV1_5_0.validationSchemaFor({ ...input, styles: ["ugc"], creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" }).safeParse(lying).success).toBe(false);
  });
});

describe("render e contrato futuro", () => {
  it("nunca duas vozes: clipe com fala nativa + narração real separada é recusado", () => {
    const { plan } = ugcPlan("economy");
    const hook = plan.scenes[0]!;
    const sceneVideos = new Map(plan.scenes.filter((s) => s.requiresGeneratedVideo).map((s) => [s.id, `mock://v/${s.id}`]));
    for (const isMock of [false, true]) {
      expect(() => buildRenderManifest({ campaignId: "c", plan, product: p, sceneVideos, clipAudioSceneIds: new Set([hook.id]), narration: { uri: isMock ? "mock://audio/x.mp3" : "outputs/audio/x.mp3", durationSeconds: 10, isMock }, outputDir: "outputs" })).toThrow(/duplicado/);
    }
    const ok = buildRenderManifest({ campaignId: "c", plan, product: p, sceneVideos, clipAudioSceneIds: new Set([hook.id]), outputDir: "outputs" });
    expect(ok.assets[0]!.clipAudio).toBe(true);
    expect(ok.audio).toEqual([]);
  });

  it("contrato Google preparado: Nano Banana + Veo, fala nativa e sem narração externa", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: p, request: { presenter: "woman", environment: "kitchen", visualStyle: "natural_smartphone" } });
    const anchor = productAnchor(p)!;
    const ref = buildGoogleUgcReferenceRequest({ product: anchor, identity, prompt: "x", aspectRatio: "9:16" });
    expect(ref).toMatchObject({ provider: "google", model: "gemini-3.1-flash-image", responseFormat: { aspectRatio: "9:16", imageSize: "1K" } });
    expect(ref.input[1]).toMatchObject({ sourceUri: anchor.imageUri, purpose: "preserve_product" });
    const video = { sceneId: "s", role: "ugc_hook" as const, reference: { id: "r", version: "v1", imageUri: "outputs/ugc/x.png", approved: true as const }, identity, product: anchor, speech: "Olha isso aqui", action: "segura", durationSeconds: 5, aspectRatio: "9:16" as const, additionalReferenceUris: [anchor.imageUri] };
    const built = buildVeoUgcVideoRequest(video, ugcVeoPreset("high"));
    expect(built.config).toMatchObject({ generateAudio: true, durationSeconds: "8", aspectRatio: "9:16", resolution: "720p" });
    expect(built.config.referenceImages).toHaveLength(1);
    expect(() => buildVeoUgcVideoRequest({ ...video, audio: { data: new Uint8Array(), startSeconds: 0, endSeconds: 1, narrationVersion: "v1" } }, ugcVeoPreset("high"))).toThrow(/áudio nativo/);
  });
});
