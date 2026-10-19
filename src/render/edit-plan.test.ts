import { describe, expect, it } from "vitest";
import { buildMockDraft } from "@/ai/mock-planner";
import { hydrateCampaignPlan } from "@/ai/hydrate";
import { applyUgcEditorial } from "@/ai/ugc-editorial";
import { EDIT_POLICY } from "@/config/edit-policy";
import { SIMPLE_UGC_QUALITY_PRESETS } from "@/config/simple-presets";
import type { CreativePlan } from "@/domain/creative";
import { assertValidEditPlan, EditPlanError, EditPlanSchema, SceneEditSchema } from "@/domain/edit";
import { RenderManifestSchema } from "@/domain/render";
import { product } from "@/test/fixtures";
import { buildCompositionProps, compositionHasAudio } from "./composition-props";
import { buildEditedRenderManifest } from "./edit-manifest";
import { buildEditPlan, captionChunks, usableWindow, type EditClip } from "./edit-plan";
import type { ResolvedAsset } from "./asset-resolver";

const p = product({ features: ["2100W de potência", "Bico concentrador"], benefits: ["Seca rápido", "Tem 3 temperaturas"] });

function editorialPlan(quality: "economy" | "high" | "premium" = "high"): CreativePlan {
  const draft = buildMockDraft({ product: p, styles: ["ugc"], creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS[quality], creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" });
  let n = 0;
  const plan = hydrateCampaignPlan(draft, p, (prefix) => `${prefix}_${++n}`).creatives[0]!;
  return applyUgcEditorial(plan, { quality, finalRange: SIMPLE_UGC_QUALITY_PRESETS[quality].finalVideoSeconds }).plan;
}

/** Veo vende 8s; o arquivo real tem 8s; a edição usa só a janela entre os handles. */
function clipsFor(plan: CreativePlan, seconds = 8): Map<string, EditClip> {
  return new Map(plan.scenes.filter((s) => s.edit?.role === "aroll").map((s, i) => [s.id, { uri: `outputs/videos/c/${s.id}/v1/clip.mp4`, actualSeconds: seconds, generatedSeconds: 8 + i * 0 }]));
}

const REFERENCE = "outputs/ugc/c/k/v1/reference.png";

describe("Editor V2 — plano editorial (A-roll/B-roll)", () => {
  it("UGC vira narrativa contínua: A-roll é a espinha, B-roll é overlay sem fala com motivo de corte", () => {
    const plan = editorialPlan("high");
    expect(plan.editPlanVersion).toBe(2);
    const roles = plan.scenes.map((s) => s.edit!.role);
    expect(roles).toEqual(["aroll", "broll", "aroll", "broll", "aroll"]);
    expect(plan.scenes.filter((s) => s.edit!.role === "broll").every((s) => s.edit!.overlay && !s.narration && s.visualSource === "reference_detail" && !s.requiresGeneratedVideo)).toBe(true);
    // Duração do criativo = soma dos A-rolls (overlay não soma).
    expect(plan.duration).toBe(plan.scenes.filter((s) => s.edit!.role === "aroll").reduce((a, s) => a + s.duration, 0));
    expect(plan.scenes.every((s) => s.edit!.cutReason)).toBe(true);
    expect(plan.scenes[0]!.edit!.cutReason).toBe("opening");
    expect(plan.scenes.at(-1)!.edit!.cutReason).toBe("cta_return");
    // Nunca crossfade automático.
    expect(plan.scenes.some((s) => s.edit!.transition === "crossfade")).toBe(false);
    expect(applyUgcEditorial(plan).plan).toBe(plan); // idempotente
  });

  it("continuidade encadeada: a pose de entrada de um A-roll é a pose de saída do anterior", () => {
    const arolls = editorialPlan("premium").scenes.filter((s) => s.edit!.role === "aroll");
    for (let i = 1; i < arolls.length; i++) expect(arolls[i]!.edit!.continuity!.entryPose).toBe(arolls[i - 1]!.edit!.continuity!.exitPose);
    expect(new Set(arolls.map((s) => s.edit!.continuity!.productHand)).size).toBe(1);
    expect(arolls.every((s) => s.edit!.continuity!.continuityGroup === "aroll-main" && s.edit!.continuity!.identityRevision === 1)).toBe(true);
  });

  it("catálogo é proibido por padrão (foto/card viram detalhe da referência); estilo comercial explícito libera", () => {
    const base = editorialPlan("high");
    const linear = { ...base, editPlanVersion: undefined, scenes: base.scenes.map(({ edit: _edit, ...s }) => s.visualSource === "reference_detail" ? { ...s, visualSource: "product_image" as const, motion: "ken_burns" as const } : s), duration: base.scenes.reduce((a, s) => a + s.duration, 0) };
    const normal = applyUgcEditorial(linear).plan;
    expect(normal.scenes.some((s) => s.visualSource === "product_image")).toBe(false);
    expect(normal.scenes.filter((s) => s.edit!.role === "broll").every((s) => s.edit!.brollKind === "reference_detail")).toBe(true);
    const commercial = applyUgcEditorial(linear, { commercialStyle: true }).plan;
    expect(commercial.scenes.filter((s) => s.visualSource === "product_image").every((s) => s.edit!.brollKind === "product_photo")).toBe(true);
  });

  it("B-roll antes do gancho ou depois do CTA sai (o vídeo abre e fecha na apresentadora)", () => {
    const base = editorialPlan("economy");
    const [hook, broll, cta] = base.scenes;
    const linear = { ...base, editPlanVersion: undefined, scenes: [broll!, hook!, cta!, { ...broll!, id: "late" }].map(({ edit: _e, ...s }, order) => ({ ...s, order })), duration: 7.5 + 7.5 + 1.6 + 1.6 };
    const result = applyUgcEditorial(linear);
    expect(result.plan.scenes[0]!.visualSource).toBe("ugc_hook");
    expect(result.plan.scenes.at(-1)!.visualSource).toBe("ugc_cta");
    expect(result.adjustments.join(" ")).toMatch(/antes do gancho/);
  });

  it("schema: B-roll sempre overlay; cut reason obrigatório", () => {
    expect(SceneEditSchema.safeParse({ version: 2, role: "broll", overlay: false, cutReason: "detail_emphasis", transition: "cut_on_action", continuityGroup: "d", brollKind: "reference_detail" }).success).toBe(false);
    expect(SceneEditSchema.safeParse({ version: 2, role: "aroll", overlay: false, transition: "straight_cut", continuityGroup: "a" }).success).toBe(false);
  });
});

describe("Editor V2 — Edit Plan", () => {
  it("handles: janela usada menor que a gerada; clipe curto demais usa o clipe inteiro", () => {
    expect(usableWindow(8, EDIT_POLICY.handles.aroll)).toEqual({ sourceIn: 0.3, sourceOut: 7.6 });
    expect(usableWindow(1.6, EDIT_POLICY.handles.aroll)).toEqual({ sourceIn: 0, sourceOut: 1.6 });
  });

  it("A-roll contínuo + B-roll overlay mudo: áudio só do A-roll, sem sobreposição, cobrindo o vídeo inteiro", () => {
    const plan = editorialPlan("high");
    const edit = buildEditPlan({ plan, clips: clipsFor(plan), referenceImageUri: REFERENCE });
    const arolls = plan.scenes.filter((s) => s.edit!.role === "aroll");
    expect(edit.durationSeconds).toBeCloseTo(3 * 7.3, 6);
    // Áudio: uma faixa por A-roll, contígua, janela = handles.
    expect(edit.audio.map((a) => a.sceneId)).toEqual(arolls.map((s) => s.id));
    expect(edit.audio[0]).toMatchObject({ startSeconds: 0, endSeconds: 7.3, sourceInSeconds: 0.3, sourceOutSeconds: 7.6, fadeInSeconds: 0 });
    expect(edit.audio[1]!.startSeconds).toBe(edit.audio[0]!.endSeconds);
    expect(edit.audio[1]!.fadeInSeconds).toBeGreaterThan(0);
    // Visuais: todos mudos; B-roll em cima da junção (L/J cut) com áudio do A-roll.
    expect(edit.visuals.every((v) => v.muted)).toBe(true);
    const brolls = edit.visuals.filter((v) => v.role === "broll");
    expect(brolls).toHaveLength(2);
    const junction = edit.audio[0]!.endSeconds;
    expect(brolls[0]!.startSeconds).toBeLessThan(junction);
    expect(brolls[0]!.endSeconds).toBeGreaterThan(junction);
    expect(brolls[0]).toMatchObject({ media: "image", uri: REFERENCE, cutReason: "product_reveal", audioSceneId: arolls[0]!.id });
    expect(edit.audio.some((a) => brolls.some((b) => b.sceneId === a.sceneId))).toBe(false);
    // A volta para o A-roll seguinte continua sincronizada: visual sourceIn = áudio sourceIn + deslocamento.
    const resumed = edit.visuals.find((v) => v.role === "aroll" && v.sceneId === arolls[1]!.id)!;
    expect(resumed.sourceInSeconds).toBeCloseTo(0.3 + (resumed.startSeconds - edit.audio[1]!.startSeconds), 6);
    expect(resumed.cutReason).toBe("action_match");
    expect(edit.visuals.at(-1)!.role).toBe("aroll");
  });

  it("todo corte tem motivo; o primeiro é a abertura; junção direta usa punch-in sutil, nunca crossfade", () => {
    const plan = editorialPlan("high");
    const noBroll = { ...plan, scenes: plan.scenes.filter((s) => s.edit!.role === "aroll").map((s, order) => ({ ...s, order })) };
    const edit = buildEditPlan({ plan: noBroll, clips: clipsFor(plan), referenceImageUri: REFERENCE });
    expect(edit.visuals[0]!.cutReason).toBe("opening");
    expect(edit.visuals.slice(1).every((v) => v.cutReason !== "opening")).toBe(true);
    expect(edit.visuals[1]).toMatchObject({ transition: "punch_in", cutReason: "sentence_boundary", scale: EDIT_POLICY.punchInScale });
    expect(edit.visuals[2]).toMatchObject({ scale: 1, cutReason: "cta_return" });
    expect(edit.visuals.some((v) => v.transition === "crossfade")).toBe(false);
    expect(() => assertValidEditPlan({ ...edit, visuals: edit.visuals.map((v, i) => (i === 1 ? { ...v, cutReason: "opening" as const } : v)) })).toThrow(/motivo/);
  });

  it("nunca áudio duplicado; B-roll nunca é fonte de áudio", () => {
    const plan = editorialPlan("high");
    const edit = buildEditPlan({ plan, clips: clipsFor(plan), referenceImageUri: REFERENCE });
    expect(() => assertValidEditPlan({ ...edit, audio: [...edit.audio, { ...edit.audio[0]!, startSeconds: 1, endSeconds: 8.3 }] })).toThrow(EditPlanError);
    const broll = edit.visuals.find((v) => v.role === "broll")!;
    expect(() => assertValidEditPlan({ ...edit, audio: [...edit.audio.slice(0, 2).map((a, i) => (i === 1 ? a : a)), { ...edit.audio[2]!, sceneId: broll.sceneId }] })).toThrow(/B-roll nunca/);
  });

  it("generated ≠ used: 8s gerados (cobrados), 7,3s usados; o uso nunca altera o gerado", () => {
    const plan = editorialPlan("economy");
    const edit = buildEditPlan({ plan, clips: clipsFor(plan), referenceImageUri: REFERENCE });
    const arollUsage = edit.usage.filter((u) => u.role === "aroll");
    expect(arollUsage).toHaveLength(2);
    expect(arollUsage.every((u) => u.generatedSeconds === 8 && Math.abs(u.usedSeconds - 7.3) < 1e-9)).toBe(true);
    // B-roll de referência não é gerado: não aparece como clipe pago.
    expect(edit.usage.some((u) => u.role === "broll")).toBe(false);
  });

  it("B-roll não entra na janela do CTA: a apresentadora fica em cena com CTA pequeno", () => {
    const plan = editorialPlan("economy");
    const edit = buildEditPlan({ plan, clips: clipsFor(plan, 4), referenceImageUri: REFERENCE, ctaLabel: "Veja no carrinho" });
    expect(edit.cta).toMatchObject({ text: "Veja no carrinho", overPresenter: true, endSeconds: edit.durationSeconds });
    const ctaStart = edit.cta!.startSeconds;
    expect(edit.visuals.filter((v) => v.role === "broll").every((v) => v.endSeconds <= ctaStart + 1e-6)).toBe(true);
  });

  it("legendas: uma zona, ≤ 2 linhas, sem duplicação; hook textual só quando não repete a fala", () => {
    const plan = editorialPlan("high");
    const edit = buildEditPlan({ plan, clips: clipsFor(plan), referenceImageUri: REFERENCE, hookText: plan.scenes[0]!.narration });
    expect(edit.hook).toBeUndefined(); // repetiria a fala
    const texts = edit.captions.map((c) => c.text);
    expect(new Set(texts.map((t, i) => `${t}@${edit.captions[i]!.startSeconds}`)).size).toBe(texts.length);
    expect(edit.captions.every((c) => c.text.length <= EDIT_POLICY.caption.maxLines * EDIT_POLICY.caption.maxCharsPerLine + 20)).toBe(true);
    for (let i = 1; i < edit.captions.length; i++) expect(edit.captions[i]!.startSeconds).toBeGreaterThanOrEqual(edit.captions[i - 1]!.endSeconds - 1e-6);
    const deliberate = buildEditPlan({ plan, clips: clipsFor(plan), referenceImageUri: REFERENCE, hookText: "Secador que não pesa" });
    expect(deliberate.hook).toMatchObject({ text: "Secador que não pesa" });
    expect(captionChunks("Ele tem 2100W de potência e bico concentrador.", 0, 3, "s").flatMap((c) => c.emphasis)).toEqual(["2100W"]);
  });

  it("plano antigo (sem metadados editoriais) não usa o Editor V2", () => {
    const plan = editorialPlan("high");
    expect(() => buildEditPlan({ plan: { ...plan, editPlanVersion: undefined }, clips: clipsFor(plan) })).toThrow(/Editor V2/);
  });
});

describe("Editor V2 — manifest e props Remotion (fixture local)", () => {
  const plan = editorialPlan("high");
  const manifest = buildEditedRenderManifest({ campaignId: "campaign_1", plan, product: p, clips: clipsFor(plan), referenceImageUri: REFERENCE, outputDir: "outputs" });

  it("manifest carrega o Edit Plan; assets autorizáveis por trecho; sem narração separada", () => {
    expect(RenderManifestSchema.parse(manifest).edit).toBeDefined();
    expect(EditPlanSchema.parse(manifest.edit)).toBeTruthy();
    expect(manifest.audio).toEqual([]);
    expect(manifest.duration).toBe(manifest.edit!.durationSeconds);
    expect(new Set(manifest.assets.map((a) => a.uri))).toEqual(new Set([...clipsFor(plan).values()].map((c) => c.uri).concat(REFERENCE)));
    expect(manifest.edit!.cta).toMatchObject({ text: "Veja no carrinho", overPresenter: true });
  });

  it("props V2: visual mudo com trim (handles), áudio separado com fades, imagem de referência com recorte", () => {
    const assets = new Map<string, ResolvedAsset>([
      ...[...clipsFor(plan).values()].map((c) => [c.uri, { kind: "file", media: "video", uri: c.uri, absolutePath: `/x/${c.uri}`, contentType: "video/mp4" }] as [string, ResolvedAsset]),
      [REFERENCE, { kind: "file", media: "image", uri: REFERENCE, absolutePath: "/x/ref.png", contentType: "image/png", size: { width: 1080, height: 1920 } }],
    ]);
    const { props, warnings } = buildCompositionProps({ manifest, assets, urlFor: (u) => `http://asset/${u}` });
    const edit = props.edit!;
    expect(edit.version).toBe(2);
    expect(props.scenes).toEqual([]); // nada de montagem linear
    expect(edit.visuals[0]).toMatchObject({ kind: "video", trimBeforeFrames: 9, role: "aroll" });
    expect(edit.visuals.find((v) => v.role === "broll")).toMatchObject({ kind: "image", crop: expect.objectContaining({ focusX: expect.any(Number) }) });
    expect(edit.audio).toHaveLength(3);
    expect(edit.audio[0]).toMatchObject({ trimBeforeFrames: 9, fadeInFrames: 0, gain: 1 });
    expect(edit.audio[1]!.fadeInFrames).toBeGreaterThan(0);
    expect(compositionHasAudio(props)).toBe(true);
    // Visuais contíguos até o último frame.
    for (let i = 1; i < edit.visuals.length; i++) expect(edit.visuals[i]!.startFrame).toBe(edit.visuals[i - 1]!.startFrame + edit.visuals[i - 1]!.durationFrames);
    expect(edit.visuals.at(-1)!.startFrame + edit.visuals.at(-1)!.durationFrames).toBe(props.durationInFrames);
    expect(edit.cta).toMatchObject({ text: "Veja no carrinho", endFrame: props.durationInFrames });
    expect(warnings).toEqual([]);
  });

  it("mock: placeholder explícito e sem som (nunca parece vídeo gerado)", () => {
    const mock = new Map<string, ResolvedAsset>([...clipsFor(plan).values()].map((c) => [c.uri, { kind: "mock", uri: c.uri }] as [string, ResolvedAsset]));
    const { props, warnings } = buildCompositionProps({ manifest, assets: mock, urlFor: (u) => u });
    expect(props.edit!.visuals.every((v) => v.kind === "placeholder")).toBe(true);
    expect(props.edit!.audio).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain("audio_unavailable");
  });
});
