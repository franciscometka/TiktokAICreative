import { describe, expect, it } from "vitest";
import { buildMockDraft } from "@/ai/mock-planner";
import { hydrateCampaignPlan } from "@/ai/hydrate";
import { applyPresenterOnly } from "@/ai/ugc-presenter-only";
import { validatePresenterScript, findUgcSpeechViolations } from "@/ai/ugc-script";
import { buildUgcVideoPrompt } from "@/ai/ugc-video-prompt";
import { PRESENTER_POLICY, UGC_PRESENTER_PLANS } from "@/config/edit-policy";
import { PRICING_TABLE } from "@/config/pricing";
import { SIMPLE_UGC_QUALITY_PRESETS } from "@/config/simple-presets";
import { estimateCreativeCost, resolvePricing } from "@/costs/calculate";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import type { CreativePlan } from "@/domain/creative";
import { isUgcPersonSource } from "@/domain/ugc";
import { product } from "@/test/fixtures";
import { ugcHarness } from "@/test/ugc-harness";
import { captionV3BoxStyle, CAPTION_V3_BOX } from "../../remotion/components/CaptionV3";
import type { EditClip } from "./edit-plan";
import { buildEditedRenderManifest } from "./edit-manifest";
import { parseFfprobe, validateRenderedMedia } from "./remotion/media-probe";
import { auditEditTimeline, buildPresenterEditPlan, captionLines, presenterWindow } from "./presenter-edit-plan";

const p = product({ name: "Secador Turbo 2100", features: ["2100 watts de potência", "Bico concentrador", "Cabo de 1,8 metro"], benefits: ["Seca o cabelo no dia a dia", "Tem 3 temperaturas"] });

function presenterPlan(quality: "economy" | "high" | "premium" = "high"): CreativePlan {
  const draft = buildMockDraft({ product: p, styles: ["ugc"], creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS[quality], creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" });
  let n = 0;
  const plan = hydrateCampaignPlan(draft, p, (prefix) => `${prefix}_${++n}`).creatives[0]!;
  return applyPresenterOnly(plan).plan;
}

/** Clipe Veo de 8s: respiração inicial 0–0,35s, pausa no meio e silêncio final depois da fala. */
function clipsFor(plan: CreativePlan, opts: { speechEnd?: number; actual?: number } = {}): Map<string, EditClip> {
  const actual = opts.actual ?? 8;
  const speechEnd = opts.speechEnd ?? 7.1;
  return new Map(plan.scenes.map((s) => [s.id, {
    uri: `outputs/videos/c/${s.id}/v1/clip.mp4`, actualSeconds: actual, generatedSeconds: 8,
    audioSilence: { source: "ffmpeg_silencedetect" as const, noiseDb: -38, minSilenceSeconds: 0.12,
      intervals: [{ startSeconds: 0, endSeconds: 0.35 }, { startSeconds: 3.4, endSeconds: 3.6 }, ...(speechEnd < actual ? [{ startSeconds: speechEnd, endSeconds: actual }] : [])] },
  }]));
}

describe("Presenter Only — plano (Lote 5.7)", () => {
  it("novo job AI UGC não cria B-roll: só trechos da apresentadora, V3", async () => {
    const h = await ugcHarness();
    const plan = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!;
    expect(plan.editPlanVersion).toBe(3);
    expect(plan.scenes.every((s) => isUgcPersonSource(s.visualSource) && s.edit?.role === "aroll")).toBe(true);
    const job = await h.service.getJob(h.jobId);
    expect(job.scenes).toHaveLength(plan.scenes.length);
  });

  it("B-roll, foto e card de um plano antigo/LLM nunca entram (removidos com ajuste registrado)", () => {
    const base = presenterPlan();
    const withStatic = { ...base, editPlanVersion: undefined, scenes: [...base.scenes.map((s) => ({ ...s, edit: undefined })),
      { ...base.scenes[0]!, id: "img", visualSource: "product_image" as const, narration: "", requiresGeneratedVideo: false }] };
    const result = applyPresenterOnly(withStatic);
    expect(result.plan.scenes.some((s) => s.id === "img")).toBe(false);
    expect(result.adjustments.join(" ")).toMatch(/removida/);
  });

  it.each(["economy", "high", "premium"] as const)("preset %s: 5–6 trechos, ≥ 30s planejados, fala natural", (quality) => {
    const plan = presenterPlan(quality);
    expect(plan.scenes.length).toBe(UGC_PRESENTER_PLANS[quality].length);
    expect(plan.scenes.length).toBeGreaterThanOrEqual(5);
    expect(plan.duration).toBeGreaterThanOrEqual(30);
    expect(plan.scenes.at(-1)!.edit!.finalTail).toBe(true);
    for (const s of plan.scenes) expect(findUgcSpeechViolations(s.narration)).toEqual([]);
    expect(plan.scenes.at(-1)!.narration).toMatch(/carrinho/);
  });

  it("plano curto nunca fica < 30s: trechos crescem até 8s", () => {
    const base = presenterPlan("economy");
    const short = { ...base, editPlanVersion: undefined, scenes: base.scenes.map((s) => ({ ...s, duration: 4, edit: undefined })) };
    expect(applyPresenterOnly(short).plan.duration).toBeGreaterThanOrEqual(30);
  });

  it("continuidade passa entre os trechos (entrada = saída do anterior) e chega ao prompt", () => {
    const plan = presenterPlan();
    for (let i = 1; i < plan.scenes.length; i++) expect(plan.scenes[i]!.edit!.continuity!.entryPose).toBe(plan.scenes[i - 1]!.edit!.continuity!.exitPose);
    const last = plan.scenes.at(-1)!;
    const prompt = buildUgcVideoPrompt({ action: "holds the product", speech: last.narration, continuity: last.edit!.continuity!, finalTail: true });
    expect(prompt).toContain(plan.scenes.at(-2)!.edit!.continuity!.exitPose);
    expect(prompt).toMatch(/about one second without speaking/);
    expect(prompt).toMatch(/plastic or overly smooth skin/);
  });

  it("roteiro Claude: proíbe exagero/urgência e exige 5–6 trechos e ~75–95 palavras", () => {
    expect(findUgcSpeechViolations("Você precisa disso! CORRA, últimas unidades.").length).toBeGreaterThanOrEqual(2);
    expect(validatePresenterScript([{ visualSource: "ugc_hook", narration: "Olha isso." }])).not.toEqual([]);
    const plan = presenterPlan();
    const ok = plan.scenes.map((s, i) => ({ visualSource: s.visualSource, narration: i === plan.scenes.length - 1 ? s.narration : `${s.narration} ${"palavra ".repeat(8)}` }));
    expect(validatePresenterScript(ok).filter((m) => /trechos|último/.test(m))).toEqual([]);
  });

  it("custo reflete TODOS os trechos gerados (8s Veo cada), sem B-roll nem TTS", () => {
    const plan = presenterPlan("high");
    const pricing = resolvePricing(SIMPLE_UGC_QUALITY_PRESETS.high, new StaticPricingCatalog(PRICING_TABLE));
    const estimate = estimateCreativeCost({ id: "e", plan, settings: SIMPLE_UGC_QUALITY_PRESETS.high, pricing, incurred: { llmCost: { usd: 0, brl: 0 }, ledgerEntryIds: [], sharedAmongCreatives: 1, simulated: true }, exchangeRate: 5, createdAt: "t", nativeUgcSpeech: true });
    const scenes = estimate.breakdown.filter((l) => l.category === "ugc_scene");
    expect(scenes).toHaveLength(plan.scenes.length);
    expect(scenes.every((l) => l.quantity === 8)).toBe(true);
    expect(estimate.breakdown.some((l) => l.category === "broll" || l.category === "audio")).toBe(false);
  });
});

describe("Edit Plan V3 — timeline, cauda, áudio e legendas", () => {
  it("só A-rolls em vídeo; duração ≥ 30s; tempos na grade de frames; áudio contíguo (sem lacuna/overlap)", () => {
    const plan = presenterPlan("high");
    const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan) });
    expect(edit.version).toBe(3);
    expect(edit.visuals.every((v) => v.role === "aroll" && v.media === "video")).toBe(true);
    expect(edit.durationSeconds).toBeGreaterThanOrEqual(30);
    const onGrid = (x: number) => Math.abs(x * 30 - Math.round(x * 30)) < 1e-6;
    expect([...edit.visuals, ...edit.audio].every((t) => onGrid(t.startSeconds) && onGrid(t.endSeconds))).toBe(true);
    expect(auditEditTimeline(edit)).toEqual([]);
    expect(edit.audio).toHaveLength(edit.visuals.length);
    edit.audio.forEach((track, i) => {
      if (i > 0) expect(track.startSeconds).toBe(edit.audio[i - 1]!.endSeconds);
      expect(track.endSeconds - track.startSeconds).toBeCloseTo(track.sourceOutSeconds - track.sourceInSeconds, 6);
    });
    expect(edit.visuals.slice(1).every((v) => ["natural_pause", "sentence_boundary", "action_match"].includes(v.cutReason))).toBe(true);
    expect(edit.visuals.every((v) => v.speech && v.continuity)).toBe(true);
    expect(edit.usage.every((u) => u.generatedSeconds === 8 && u.usedSeconds < 8)).toBe(true);
  });

  it("último trecho mantém 0,8–1,2s de vídeo depois da última palavra; a fala (CTA) termina antes da cauda", () => {
    const plan = presenterPlan();
    const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan, { speechEnd: 6.6 }) });
    expect(edit.finalTailSeconds).toBeGreaterThanOrEqual(PRESENTER_POLICY.finalTail.minSeconds);
    expect(edit.finalTailSeconds).toBeLessThanOrEqual(PRESENTER_POLICY.finalTail.maxSeconds + 1 / 30);
    const lastCaption = edit.captions.at(-1)!;
    expect(lastCaption.endSeconds).toBeLessThanOrEqual(edit.durationSeconds - PRESENTER_POLICY.finalTail.minSeconds + 1e-6);
    expect(edit.visuals.at(-1)!.finalTailSeconds).toBe(edit.finalTailSeconds);
  });

  it("nunca corta fala no final: fala encostada no fim do clipe mantém o clipe inteiro e avisa", () => {
    const plan = presenterPlan();
    const clip = clipsFor(plan, { speechEnd: 8 }).get(plan.scenes.at(-1)!.id)!;
    expect(presenterWindow(clip, true).sourceOut).toBe(8);
    const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan, { speechEnd: 8 }) });
    expect(edit.visuals.at(-1)!.sourceOutSeconds).toBe(8);
    expect(edit.warnings!.join(" ")).toMatch(/encosta no fim/);
  });

  it("handles adaptativos: só cortam dentro de pausa medida; sem medição, clipe inteiro", () => {
    const window = presenterWindow({ uri: "x", actualSeconds: 8, generatedSeconds: 8, audioSilence: { source: "ffmpeg_silencedetect", noiseDb: -38, minSilenceSeconds: 0.12, intervals: [{ startSeconds: 0, endSeconds: 0.5 }, { startSeconds: 7.2, endSeconds: 8 }] } }, false);
    expect(window.sourceIn).toBeCloseTo(0.5 - PRESENTER_POLICY.handles.keepLeadSilenceSeconds, 6);
    expect(window.sourceOut).toBeCloseTo(7.2 + PRESENTER_POLICY.handles.keepTrailSilenceSeconds, 6);
    expect(presenterWindow({ uri: "x", actualSeconds: 8, generatedSeconds: 8 }, false)).toMatchObject({ sourceIn: 0, sourceOut: 8 });
  });

  it("legendas: ≤ 2 linhas, trocam fora das palavras medidas, mapeadas às pausas, sem sobreposição", () => {
    const plan = presenterPlan();
    const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan) });
    expect(edit.captions.length).toBeGreaterThan(plan.scenes.length);
    for (const c of edit.captions) {
      const lines = captionLines(c.text);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(c.timingSource).toBe("mapped_to_audio_pauses");
    }
    for (let i = 1; i < edit.captions.length; i++) expect(edit.captions[i]!.startSeconds).toBeGreaterThanOrEqual(edit.captions[i - 1]!.endSeconds - 1e-6);
  });

  it("Caption V3: caixa fixa, centralizada, sem rotation/skew/transform; posição independe do texto/frame", () => {
    const style = captionV3BoxStyle();
    expect(style.transform).toBe("none");
    expect(JSON.stringify(style)).not.toMatch(/rotate|skew|translate/);
    expect(CAPTION_V3_BOX.left + CAPTION_V3_BOX.width / 2).toBe(540); // centro do canvas 1080
    expect(captionV3BoxStyle()).toEqual(style); // mesma âncora sempre
  });

  it("CTA não cria card final: o fim é a apresentadora em vídeo, CTA pequeno por cima; manifest sem hook", () => {
    const plan = presenterPlan();
    const manifest = buildEditedRenderManifest({ campaignId: "c", plan, product: p, clips: clipsFor(plan), outputDir: "outputs" });
    const edit = manifest.edit!;
    expect(edit.visuals.at(-1)).toMatchObject({ role: "aroll", media: "video" });
    expect(edit.cta?.overPresenter).toBe(true);
    expect(edit.hook).toBeUndefined();
    expect(manifest.assets.every((a) => a.kind === "generated_video")).toBe(true);
  });
});

describe("validação pós-render", () => {
  const json = (rate: number, duration = "36.200") => JSON.stringify({ format: { duration }, streams: [
    { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac", sample_rate: String(rate), channels: 2, duration } ] });

  it("aceita AAC 48 kHz estéreo com duração certa; acusa sample rate, duração e trilha divergentes", () => {
    expect(validateRenderedMedia(parseFfprobe(json(48_000)), { durationSeconds: 36.2, hasAudio: true, fps: 30 })).toEqual([]);
    expect(validateRenderedMedia(parseFfprobe(json(44_100)), { durationSeconds: 36.2, hasAudio: true, fps: 30 }).join(" ")).toMatch(/44100 Hz/);
    expect(validateRenderedMedia(parseFfprobe(json(48_000, "30.0")), { durationSeconds: 36.2, hasAudio: true, fps: 30 }).join(" ")).toMatch(/Duração/);
  });
});

describe("compatibilidade e fidelidade", () => {
  it("fidelity gate continua: com referência pendente, nenhuma cena Presenter Only é gerada", async () => {
    const h = await ugcHarness();
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const quote = await h.service.quoteStage(h.jobId, "ugc_video");
    expect(quote.ready).toBe(false);
    expect(h.calls.videos()).toHaveLength(0);
  });
});
