import { describe, expect, it } from "vitest";
import { buildMockDraft } from "@/ai/mock-planner";
import { fitSpeech } from "@/ai/mock-ugc-planner";
import { PRICING_TABLE } from "@/config/pricing";
import { SIMPLE_UGC_QUALITY_PRESETS } from "@/config/simple-presets";
import { productAnchor, resolveUgcIdentity, suggestEnvironment, UGC_PRESET_PLANS } from "@/config/ugc";
import { estimateCreativeCost, resolvePricing } from "@/costs/calculate";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { hydrateCampaignPlan } from "@/ai/hydrate";
import { isUgcPersonSource, UgcCharacterProfileSchema } from "@/domain/ugc";
import { buildRenderManifest } from "@/render/manifest";
import { prepareGoogleUgcReference, prepareGoogleUgcVideo } from "@/providers/ugc/google-ugc-contract";
import { product } from "@/test/fixtures";
import { buildUgcReferencePrompt, findUgcSpeechViolations, speechFitsDuration, validateUgcScenes } from "./ugc-script";
import { campaignPlanPromptV1_5_0 } from "./prompts/campaign-plan.v1_5_0";
import { ACTIVE_PROMPTS } from "./prompts/registry";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const p = product();

function ugcPlan(quality: "economy" | "high" | "premium", strategy: "native_speech" | "external_lipsync" = "native_speech") {
  const draft = buildMockDraft({ product: p, styles: ["ugc"], creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS[quality], creativeMode: "ai_ugc", ugcAudioStrategy: strategy });
  let n = 0;
  return { draft, plan: hydrateCampaignPlan(draft, p, (prefix) => `${prefix}_${++n}`).creatives[0]! };
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
    const plan = UGC_PRESET_PLANS[quality];
    expect(scenes.map((s) => s.visualSource)).toEqual(plan.map((e) => e.source));
    const duration = draft.creatives[0]!.duration;
    expect(duration).toBeGreaterThanOrEqual(SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds.min);
    expect(duration).toBeLessThanOrEqual(SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds.max);
    for (const s of scenes) expect(findUgcSpeechViolations(s.narration)).toEqual([]);
  });

  it("presets: Econômico usa menos UGC e mais imagem; Premium mais UGC e B-roll", () => {
    const count = (q: "economy" | "high" | "premium", f: (s: string) => boolean) => UGC_PRESET_PLANS[q].filter((e) => f(e.source)).length;
    expect(count("economy", isUgcPersonSource)).toBe(2);
    expect(count("high", isUgcPersonSource)).toBe(3);
    expect(count("premium", isUgcPersonSource)).toBe(4);
    expect(count("economy", (s) => s === "product_image")).toBe(1);
    expect(count("premium", (s) => s === "product_broll")).toBe(2);
  });

  it("native_speech: B-roll e imagem sem fala; external_lipsync: podem ter fala", () => {
    expect(ugcPlan("high").draft.creatives[0]!.scenes.filter((s) => !isUgcPersonSource(s.visualSource)).every((s) => !s.narration)).toBe(true);
    const lipsync = ugcPlan("high", "external_lipsync").draft.creatives[0]!.scenes;
    expect(lipsync.some((s) => !isUgcPersonSource(s.visualSource) && s.narration)).toBe(true);
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
    expect(cats.filter((c) => c === "broll")).toHaveLength(1);
    expect(cats).not.toContain("audio");
    expect(estimate.ugcSceneCost!.usd).toBeGreaterThan(0);
    // Preços UGC são provisórios (sem fonte oficial) e isso aparece na estimativa.
    expect(estimate.containsPlaceholderPrices).toBe(true);
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

describe("prompt campaign-plan@1.5.0", () => {
  const input = { product: p, styles: ["ugc"] as const, creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS.high };
  it("é o ativo e inclui as regras do AI UGC", () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.5.0");
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
    expect(() => buildRenderManifest({ campaignId: "c", plan, product: p, sceneVideos, clipAudioSceneIds: new Set([hook.id]), narration: { uri: "outputs/audio/x.mp3", durationSeconds: 10, isMock: false }, outputDir: "outputs" })).toThrow(/duplicado/);
    const ok = buildRenderManifest({ campaignId: "c", plan, product: p, sceneVideos, clipAudioSceneIds: new Set([hook.id]), outputDir: "outputs" });
    expect(ok.assets[0]!.clipAudio).toBe(true);
    expect(ok.audio).toEqual([]);
  });

  it("contrato Google preparado: sem rede, não verificado, fala nativa e sem narração externa", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: p, request: { presenter: "woman", environment: "kitchen", visualStyle: "natural_smartphone" } });
    const anchor = productAnchor(p)!;
    const ref = prepareGoogleUgcReference({ product: anchor, identity, prompt: "x", aspectRatio: "9:16" });
    expect(ref).toMatchObject({ provider: "google", verified: false, role: "reference_image" });
    const video = { sceneId: "s", role: "ugc_hook" as const, reference: { id: "r", version: "v1", imageUri: "outputs/ugc/x.png" }, identity, product: anchor, speech: "Olha isso aqui", action: "segura", durationSeconds: 5, aspectRatio: "9:16" as const };
    expect(prepareGoogleUgcVideo(video).input).toMatchObject({ generateAudio: true });
    expect(() => prepareGoogleUgcVideo({ ...video, audio: { data: new Uint8Array(), startSeconds: 0, endSeconds: 1, narrationVersion: "v1" } })).toThrow(/native_speech/);
  });
});
