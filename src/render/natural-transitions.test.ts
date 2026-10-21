import { describe, expect, it } from "vitest";
import { buildMockDraft } from "@/ai/mock-planner";
import { hydrateCampaignPlan } from "@/ai/hydrate";
import { applyMasterScript, checkScriptV2, enrichSegments, personaFor, splitMasterScript } from "@/ai/master-script";
import { campaignPlanPromptV1_9_0 } from "@/ai/prompts/campaign-plan.v1_9_0";
import { ACTIVE_PROMPTS } from "@/ai/prompts/registry";
import { applyPresenterOnly } from "@/ai/ugc-presenter-only";
import { ACTION_TEXT, buildUgcVideoPrompt } from "@/ai/ugc-video-prompt";
import { DURATION_TARGETS } from "@/config/duration-targets";
import { PRESENTER_POLICY } from "@/config/edit-policy";
import { SIMPLE_UGC_QUALITY_PRESETS, withTargetDuration } from "@/config/simple-presets";
import type { CreativePlan } from "@/domain/creative";
import { assertValidEditPlan, EDIT_TRANSITIONS, TRANSITION_LIMITS, TransitionSpecSchema, type EditPlan, type SceneContinuity } from "@/domain/edit";
import { product } from "@/test/fixtures";
import type { EditClip } from "./edit-plan";
import { buildEditedRenderManifest } from "./edit-manifest";
import { buildCompositionProps } from "./composition-props";
import { auditEditTimeline, buildPresenterEditPlan } from "./presenter-edit-plan";
import { chooseTransition, continuitySide, plannedTransitions, type ContinuitySide } from "./natural-transitions";

/*
 * Lote 6.2 — Natural UGC Editing + Script V2. Tudo puro/offline.
 */

const SECADOR = product({
  name: "Secador de Cabelos Profissional Color Wind Santa Clara 2100W 220V",
  description: "Secador profissional.",
  features: ["2100W de potência", "Bico direcionador", "Cabo de 1,8 metro"],
  benefits: ["Seca e modela no dia a dia"],
});

function plan30(): CreativePlan {
  const settings = withTargetDuration(SIMPLE_UGC_QUALITY_PRESETS.high, DURATION_TARGETS[30]);
  const draft = buildMockDraft({ product: SECADOR, styles: ["ugc"], creativeCount: 1, settings, creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech", ugcPresenterOnly: true, targetDurationSeconds: 30 });
  let n = 0;
  const hydrated = hydrateCampaignPlan(draft, SECADOR, (prefix) => `${prefix}_${++n}`).creatives[0]!;
  const scripted = applyMasterScript(hydrated, { duration: 30, persona: personaFor() });
  return applyPresenterOnly(scripted, { minFinalSeconds: 30 }).plan;
}

/** Clipe Veo de 8s: respiração 0–0,35s, pausa no meio e silêncio depois da fala (7,1s). */
function clipsFor(plan: CreativePlan, actual = 8, speechEnd = 7.1): Map<string, EditClip> {
  return new Map(plan.scenes.map((s) => [s.id, {
    uri: `outputs/videos/c/${s.id}/v1/clip.mp4`, actualSeconds: actual, generatedSeconds: 8,
    audioSilence: { source: "ffmpeg_silencedetect" as const, noiseDb: -38, minSilenceSeconds: 0.12,
      intervals: [{ startSeconds: 0, endSeconds: 0.35 }, { startSeconds: 3.4, endSeconds: 3.6 }, { startSeconds: speechEnd, endSeconds: actual }] },
  }]));
}

const side = (over: Partial<ContinuitySide> = {}): ContinuitySide => ({
  productPosition: "chest", productHand: "right", eyeDirection: "camera", cameraDistance: "medium_close", presenterPosition: "center",
  motionDirection: "none", cameraPosition: "front_eye_level", ...over,
});

describe("Natural Transition Engine — escolha e limites", () => {
  it("prioridade: match cut > cut on action > micro punch > motion blur > micro dissolve", () => {
    expect(chooseTransition({ previous: side(), next: side(), previousScale: 1, previousSpareFrames: 10 })).toMatchObject({ type: "direct_match_cut", frames: 0 });
    expect(chooseTransition({ previous: side({ exitAction: "rotate_product", eyeDirection: "product" }), next: side({ entryAction: "rotate_product", productPosition: "near_face" }), previousScale: 1, previousSpareFrames: 10 }).type).toBe("cut_on_action");
    expect(chooseTransition({ previous: side({ productPosition: "waist" }), next: side({ eyeDirection: "product", productPosition: "near_face" }), previousScale: 1, previousSpareFrames: 10 }).type).toBe("micro_punch");
    expect(chooseTransition({ previous: side({ motionDirection: "upward", cameraDistance: "medium" }), next: side({ motionDirection: "upward", productPosition: "near_face" }), previousScale: 1, previousSpareFrames: 10 })).toMatchObject({ type: "directional_motion_blur", frames: 3, blurDirection: "up" });
    expect(chooseTransition({ previous: side({ cameraDistance: "medium", eyeDirection: "product" }), next: side({ cameraDistance: "close_up", presenterPosition: "left_third" }), previousScale: 1, previousSpareFrames: 10 })).toMatchObject({ type: "micro_dissolve", blendFrames: 3 });
  });

  it("micro punch alterna 100%→103,5% e volta 103,5%→100% (não parece zoom automático)", () => {
    const a = chooseTransition({ previous: side({ productPosition: "waist" }), next: side({ productPosition: "near_face", eyeDirection: "product" }), previousScale: 1, previousSpareFrames: 0 });
    expect(a.punch).toEqual({ fromScale: 1, toScale: 1.035 });
    const b = chooseTransition({ previous: side({ productPosition: "waist" }), next: side({ productPosition: "near_face", eyeDirection: "product" }), previousScale: 1.035, previousSpareFrames: 0 });
    expect(b.punch).toEqual({ fromScale: 1.035, toScale: 1 });
    expect(a.frames).toBeGreaterThanOrEqual(3);
    expect(a.frames).toBeLessThanOrEqual(6);
  });

  it("sem vídeo sobrando, nada de blend/dissolve (nunca congela o último frame)", () => {
    const t = chooseTransition({ previous: side({ cameraDistance: "medium", eyeDirection: "product" }), next: side({ cameraDistance: "close_up", presenterPosition: "left_third" }), previousScale: 1, previousSpareFrames: 1 });
    expect(t.type).not.toBe("micro_dissolve");
    expect(t.blendFrames).toBe(0);
  });

  it("transição nunca passa de 6 frames, dissolve ≤ 4; nenhum efeito chamativo existe", () => {
    const options: Partial<ContinuitySide>[] = [{}, { productPosition: "waist" }, { motionDirection: "rotate" }, { cameraDistance: "close_up" }, { eyeDirection: "product" }, { presenterPosition: "left_third" }, { exitAction: "raise_product", entryAction: "raise_product" }];
    for (const a of options) for (const b of options) for (const spare of [0, 2, 10]) {
      const t = chooseTransition({ previous: side(a), next: side(b), previousScale: 1, previousSpareFrames: spare });
      expect(t.frames).toBeLessThanOrEqual(TRANSITION_LIMITS.maxFrames);
      expect(t.blendFrames).toBeLessThanOrEqual(TRANSITION_LIMITS.maxDissolveFrames);
      if (t.type === "micro_dissolve") expect(t.blendFrames).toBeLessThanOrEqual(4);
    }
    for (const forbidden of ["flash", "spin", "slide", "wipe", "zoom_3d"]) {
      expect(EDIT_TRANSITIONS as readonly string[]).not.toContain(forbidden);
      expect(TransitionSpecSchema.safeParse({ type: forbidden, frames: 3, reason: "x", similarity: 0 }).success).toBe(false);
    }
    expect(TransitionSpecSchema.safeParse({ type: "micro_dissolve", frames: 6, blendFrames: 6, reason: "longo", similarity: 0.5 }).success).toBe(false);
    expect(TransitionSpecSchema.safeParse({ type: "micro_punch", frames: 8, punch: { fromScale: 1, toScale: 1.035 }, reason: "longo", similarity: 0.5 }).success).toBe(false);
    expect(TransitionSpecSchema.safeParse({ type: "micro_punch", frames: 4, punch: { fromScale: 1, toScale: 1.1 }, reason: "zoom", similarity: 0.5 }).success).toBe(false);
  });
});

describe("Edit Plan V3 com transições naturais", () => {
  const plan = plan30();
  const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan) });

  it("abertura sem transição; cada junção tem transição natural em fronteira válida", () => {
    expect(edit.visuals[0]!.transitionSpec).toBeUndefined();
    for (const v of edit.visuals.slice(1)) {
      expect(v.transitionSpec).toBeDefined();
      expect(["sentence_boundary", "natural_pause"]).toContain(v.cutReason);
      expect(v.transitionSpec!.frames).toBeLessThanOrEqual(6);
    }
  });

  it("transição fora de fronteira válida ou na abertura é recusada", () => {
    const spec = edit.visuals[1]!.transitionSpec!;
    const bad = (visuals: EditPlan["visuals"]) => () => assertValidEditPlan({ ...edit, visuals });
    expect(bad(edit.visuals.map((v, i) => (i === 1 ? { ...v, cutReason: "product_reveal" as const } : v)))).toThrow(/fronteira válida/);
    expect(bad(edit.visuals.map((v, i) => (i === 0 ? { ...v, transitionSpec: spec } : v)))).toThrow(/abertura/);
  });

  it("áudio nunca sobrepõe palavra: faixas contíguas, uma por vez, fade só dentro de pausa medida", () => {
    expect(auditEditTimeline(edit)).toEqual([]);
    edit.audio.forEach((track, i) => {
      const next = edit.audio[i + 1];
      if (next) expect(next.startSeconds).toBeCloseTo(track.endSeconds, 9);
      expect(track.fadeInSeconds).toBeLessThanOrEqual(0.07);
      expect(track.fadeOutSeconds).toBeLessThanOrEqual(0.07);
    });
    // Sem pausa medida na borda → nenhum fade (nunca um "crossfade" sobre fala).
    const noSilence = new Map([...clipsFor(plan)].map(([id, c]) => [id, { ...c, audioSilence: { ...c.audioSilence!, intervals: [] } }]));
    const tight = buildPresenterEditPlan({ plan, clips: noSilence });
    expect(tight.audio.every((t) => t.fadeInSeconds === 0 && t.fadeOutSeconds === 0)).toBe(true);
    expect(auditEditTimeline(tight)).toEqual([]);
  });

  it("duração final ≥ 30s e cauda natural de 0,8–1,2s depois da última palavra", () => {
    expect(edit.durationSeconds).toBeGreaterThanOrEqual(30);
    expect(edit.finalTailSeconds!).toBeGreaterThanOrEqual(0.8);
    expect(edit.finalTailSeconds!).toBeLessThanOrEqual(1.2);
    expect(DURATION_TARGETS[30].finalVideoSeconds).toEqual({ min: 32, max: 38 });
    expect(plan.duration).toBeGreaterThanOrEqual(30);
  });

  it("props do Remotion: efeito de entrada só nos trechos 2+, ≤ 6 frames", () => {
    const manifest = buildEditedRenderManifest({ campaignId: "c", plan, product: SECADOR, clips: clipsFor(plan), outputDir: "outputs" });
    const { props } = buildCompositionProps({ manifest, assets: new Map(), urlFor: (u) => u });
    expect(props.edit!.visuals[0]!.transitionFx).toBeNull();
    for (const v of props.edit!.visuals.slice(1)) expect(v.transitionFx!.frames).toBeLessThanOrEqual(6);
  });
});

describe("continuidade (cut on action)", () => {
  const plan = plan30();

  it("a ação de saída de um trecho é a ação de entrada do próximo e chega ao prompt do vídeo", () => {
    plan.scenes.forEach((scene, i) => {
      const c = scene.edit!.continuity!;
      expect(c.exitAction).toBeDefined();
      expect(c.handPosition).toBe("right");
      expect(c.gazeDirection).toBe(c.eyeDirection);
      if (i === 0) expect(c.entryAction).toBe("hold_still");
      else expect(c.entryAction).toBe(plan.scenes[i - 1]!.edit!.continuity!.exitAction);
    });
    const second = plan.scenes[1]!.edit!.continuity!;
    const prompt = buildUgcVideoPrompt({ action: "x", speech: "Fala.", continuity: second });
    expect(prompt).toContain(`continuing the previous action: ${ACTION_TEXT[second.entryAction!]}`);
    expect(prompt).toContain("still in the middle of that movement when the shot ends");
  });

  it("último trecho: comportamento natural depois da última palavra, sem congelar", () => {
    const prompt = buildUgcVideoPrompt({ action: "x", speech: "Dá uma olhada no carrinho.", finalTail: true, continuity: plan.scenes.at(-1)!.edit!.continuity! });
    expect(prompt).toMatch(/small smile, a glance at the product, lowering the product slightly/);
    expect(prompt).toMatch(/never frozen/);
    expect(prompt).not.toMatch(/still in the middle of that movement/);
  });

  it("diagnóstico avançado: transição prevista por trecho (abertura + tipos naturais)", () => {
    const planned = plannedTransitions(plan.scenes);
    expect(planned.get(plan.scenes[0]!.id)).toBe("opening");
    expect(plan.scenes.slice(1).every((s) => ["direct_match_cut", "cut_on_action", "micro_punch", "directional_motion_blur", "micro_dissolve"].includes(planned.get(s.id)!))).toBe(true);
    expect(continuitySide(undefined)).toBeUndefined();
  });
});

describe("Script V2", () => {
  const sheet = "Esse aqui é o Color Wind. Ele é vendido como secador profissional. A potência dele é de 2100W. Vou girar ele. Ele é 220V. Esse modelo é bom. Olha esse modelo. Esse modelo de novo. Dá uma olhada no carrinho.";

  it("recusa ficha técnica, lista de especificações e muleta repetida", () => {
    const issues = checkScriptV2(sheet).join(" ");
    expect(issues).toMatch(/ficha técnica/);
    expect(issues).toMatch(/lista de especificações/);
    expect(issues).toMatch(/"esse modelo" aparece 3 vezes/);
    expect(checkScriptV2("Este produto possui duas velocidades. Dá uma olhada no carrinho.").join(" ")).toMatch(/possui\/oferece/);
  });

  it("roteiro natural (feature → contexto → ação) passa; o mock do Secador também", () => {
    expect(checkScriptV2("Ele tem 2100 watts e vem com esse bico direcionador, então dá pra controlar melhor o ar enquanto seca. Repara aqui no cabo. Se fez sentido, dá uma olhada no carrinho.")).toEqual([]);
    const plan = plan30();
    expect(checkScriptV2(plan.script)).toEqual([]);
    expect((plan.script.match(/esse modelo/gi) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("campaign-plan@1.9.0 ativo: estrutura por tempo na mensagem e validação recusa ficha técnica", () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.9.0");
    const settings = withTargetDuration(SIMPLE_UGC_QUALITY_PRESETS.high, DURATION_TARGETS[30]);
    const request = { product: SECADOR, styles: ["ugc" as const], creativeCount: 1, settings, creativeMode: "ai_ugc" as const, ugcAudioStrategy: "native_speech" as const, ugcPresenterOnly: true, targetDurationSeconds: 30 as const };
    expect(campaignPlanPromptV1_9_0.buildUserMessage(request)).toMatch(/0–5s hook \+ produto; 5–13s principal característica/);
    expect(campaignPlanPromptV1_9_0.system).toMatch(/FEATURE → CONTEXTO → AÇÃO VISUAL/);
    const draft = buildMockDraft(request);
    expect(campaignPlanPromptV1_9_0.validationSchemaFor(request).safeParse(draft).success).toBe(true);
    const bad = { ...draft, creatives: draft.creatives.map((c) => ({ ...c, script: `${c.script} Ele é vendido como secador profissional.` })) };
    const parsed = campaignPlanPromptV1_9_0.validationSchemaFor(request).safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("segmentação por pensamento/frase/ação: nunca começa trecho com \"E…/Então…\" quando há alternativa", () => {
    const text = "Esse é o secador. Ele tem 2100W. E vem com um bico direcionador. Repara no cabo de 1,8 metro. Uma coisa importante: são 3 temperaturas. Então dá pra escolher. Vale conferir o acabamento. Se fez sentido, dá uma olhada no carrinho.";
    const segments = splitMasterScript(text, 4);
    expect(segments.slice(1).some((s) => /^(e|então)\b/i.test(s))).toBe(false);
    const enriched = enrichSegments(segments);
    expect(enriched[0]).toMatchObject({ beat: "hook", transitionIntent: "opening", splitReason: "opening", entryAction: "hold_still" });
    expect(enriched.at(-1)!.beat).toBe("closing_cta");
    enriched.forEach((e, i) => { if (i > 0) expect(e.entryAction).toBe(enriched[i - 1]!.exitAction); });
    expect(enriched.find((_, i) => /bico/.test(segments[i]!))!.visualAction).toMatch(/nozzle/);
  });

  it("segmentos do roteiro mestre persistem spokenText, visualAction, entry/exitAction e transitionIntent", () => {
    const plan = plan30();
    for (const s of plan.masterScript!.segments) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.visualAction).toBeTruthy();
      expect(s.entryAction).toBeTruthy();
      expect(s.exitAction).toBeTruthy();
      expect(s.transitionIntent).toBeTruthy();
    }
  });
});

describe("compatibilidade", () => {
  it("Edit Plan V3 antigo (sem transitionSpec) continua válido e vira corte seco no Remotion", () => {
    const plan = plan30();
    const edit = buildPresenterEditPlan({ plan, clips: clipsFor(plan) });
    const legacy: EditPlan = { ...edit, visuals: edit.visuals.map(({ transitionSpec: _t, ...v }) => ({ ...v, transition: "straight_cut" as const })) };
    expect(() => assertValidEditPlan(legacy)).not.toThrow();
    const manifest = { ...buildEditedRenderManifest({ campaignId: "c", plan, product: SECADOR, clips: clipsFor(plan), outputDir: "outputs" }), edit: legacy };
    const { props } = buildCompositionProps({ manifest, assets: new Map(), urlFor: (u) => u });
    expect(props.edit!.visuals.every((v) => v.transitionFx === null)).toBe(true);
  });

  it("plano V3 antigo sem ações de continuidade: o engine nunca faz blend às cegas", () => {
    const plan = plan30();
    const old = { ...plan, scenes: plan.scenes.map((s) => ({ ...s, edit: { ...s.edit!, continuity: { ...s.edit!.continuity!, entryAction: undefined, exitAction: undefined } as SceneContinuity } })) };
    const edit = buildPresenterEditPlan({ plan: old, clips: clipsFor(old) });
    expect(auditEditTimeline(edit)).toEqual([]);
    expect(edit.visuals.slice(1).every((v) => v.transitionSpec!.frames <= 6)).toBe(true);
    expect(PRESENTER_POLICY.finalTail.minSeconds).toBe(0.8);
  });
});
