import type { GenerationSource } from "@/application/generation-view";
import type { ProjectV2View } from "@/application/project-v2-view";

/**
 * L8.5 — fixtures da tela de geração (testes e QA visual). Recortes de CampaignView/ProjectV2View
 * com a MESMA forma que o servidor produz; nenhuma chamada a provider.
 */

export function v2Fixture(over: Partial<ProjectV2View> = {}): ProjectV2View {
  return {
    phase: "generating", title: "Secador Taiff 2100W", progress: [], headline: "Gerando seu vídeo.", estimate: null, approval: null, error: null, result: null,
    avatar: { name: "Cristina", label: "Apresentado por Cristina", reason: "Cristina escolhido por você." },
    voice: { label: "Voz do próprio vídeo", reason: "Voice Lock indisponível com este provider." }, jobId: "job_1", quoteToken: "tok_1",
    ...over,
  };
}

export type SceneFixture = GenerationSource["scenes"][number];
export function sceneFixture(n: number, status: SceneFixture["status"], over: Partial<SceneFixture> = {}): SceneFixture {
  return {
    id: `scene_${n}`, number: n, startSeconds: (n - 1) * 6, endSeconds: n * 6, status,
    videoUrl: status === "ready" ? `/api/video/c/k/scene_${n}/v1` : undefined,
    narration: `Fala da cena ${n}.`, visualDescription: `Cristina mostra o secador (cena ${n}).`, motionLabel: "Câmera na mão",
    visualSource: n === 1 ? "ugc_hook" : "ugc_demo", isGenerated: true, simulated: false, ...over,
  };
}

/** 5 cenas: `ready` primeiras prontas, o resto no status `rest`. */
export function scenesFixture(ready: number, rest: SceneFixture["status"] = "generating"): SceneFixture[] {
  return [1, 2, 3, 4, 5].map((n) => sceneFixture(n, n <= ready ? "ready" : rest));
}

export function sourceFixture(over: Partial<GenerationSource> = {}): GenerationSource {
  return {
    v2: v2Fixture(), qualityLabel: "Equilibrado", targetDurationSeconds: 30, scenes: [], activityPhase: "generating", presenterReady: true,
    identity: { strategy: "avatar_reference_image", avatarName: "Cristina" }, specsCount: 2, uncertainPaidOperation: null,
    authorization: { status: "active", estimatedBrl: 20.12, baselineActualBrl: 0.4 }, jobQuote: { estimatedBrl: 20.12, ready: true }, planningQuote: null,
    actual: { totalBrl: 6.4, simulated: false }, renderDurationSeconds: null, productImageUrl: "/api/uploads/prod_1/img_1.png", fidelity: null,
    ...over,
  };
}

const APPROVAL: NonNullable<ProjectV2View["approval"]> = {
  kind: "product", title: "Confira Cristina com o produto", imageUrl: "/api/ugc/c/k/ref_1", referenceId: "ugcref_1",
  checklist: ["É Cristina: mesmo rosto da foto do avatar", "Cor e formato corretos", "Logo/textos corretos", "Especificações corretas", "“2100W” igual ao produto (ou não aparece) — nenhum número diferente"],
  specs: ["2100W"], avatarPhotoUrl: "/api/uploads/avatar_photos/img_a.png", avatarName: "Cristina", canGenerateOther: true, simulated: false,
};

/** Um recorte por estado principal da tela (ordem do QA visual). */
export const GENERATION_STATES: Record<string, GenerationSource> = {
  awaiting_approval: sourceFixture({
    v2: v2Fixture({ phase: "ready_to_generate", headline: "Roteiro pronto. Gere o vídeo quando quiser.", estimate: { label: "Estimativa: R$ 20,12", brl: 20.12, lines: [{ label: "Apresentadora", value: "R$ 1,20" }, { label: "Vídeo", value: "R$ 18,92" }, { label: "Teto autorizado", value: "R$ 24,00" }] } }),
    activityPhase: null, presenterReady: false, authorization: null, actual: { totalBrl: 0.4, simulated: false },
    scenes: scenesFixture(0, "planned"),
  }),
  queued: sourceFixture({ presenterReady: false, actual: { totalBrl: 0.4, simulated: false } }),
  planning: sourceFixture({ v2: v2Fixture({ phase: "planning" }), presenterReady: false, authorization: null, actual: { totalBrl: 0, simulated: false } }),
  reference: sourceFixture({ presenterReady: false, actual: { totalBrl: 0.4, simulated: false } }),
  fidelity: sourceFixture({ v2: v2Fixture({ phase: "product_check", approval: APPROVAL }), activityPhase: null, presenterReady: false, fidelity: { statusLabel: "Aguardando revisão", conflicts: [] }, actual: { totalBrl: 1.6, simulated: false } }),
  generating: sourceFixture({ scenes: scenesFixture(2) }),
  scene_ready: sourceFixture({ scenes: scenesFixture(4) }),
  rendering: sourceFixture({ activityPhase: "rendering", scenes: scenesFixture(5), actual: { totalBrl: 19.87, simulated: false } }),
  done: sourceFixture({
    v2: v2Fixture({ phase: "done", result: { videoUrl: "/api/renders/c/k/r1", downloadUrl: "/api/renders/c/k/r1?download=1", durationLabel: "00:31", costLabel: "R$ 19,87" } }),
    activityPhase: null, scenes: scenesFixture(5), actual: { totalBrl: 19.87, simulated: false }, renderDurationSeconds: 31.2, authorization: { status: "completed", estimatedBrl: 20.12, baselineActualBrl: 0.4 },
  }),
  scene_failed: sourceFixture({
    v2: v2Fixture({ phase: "failed", error: { message: "Não conseguimos gerar o trecho 4.", details: "Krea: tempo esgotado · Cena 4", retry: "job", sceneId: "scene_4" } }),
    activityPhase: null, scenes: [...scenesFixture(3).slice(0, 3), sceneFixture(4, "failed"), sceneFixture(5, "planned")], actual: { totalBrl: 12.1, simulated: false },
    authorization: { status: "paused", estimatedBrl: 20.12, baselineActualBrl: 0.4 }, jobQuote: { estimatedBrl: 3.98, ready: true },
  }),
  job_failed: sourceFixture({
    v2: v2Fixture({ phase: "failed", error: { message: "A geração foi interrompida.", details: "Sem detalhes.", retry: "job" } }),
    activityPhase: null, presenterReady: true, scenes: scenesFixture(2, "planned"), jobQuote: { estimatedBrl: 12, ready: false },
  }),
  blocked: sourceFixture({
    v2: v2Fixture({ phase: "failed", error: { message: "A geração foi interrompida.", details: "Sem detalhes.", retry: "job" } }),
    activityPhase: null, scenes: scenesFixture(2, "planned"), uncertainPaidOperation: "operação de vídeo UGC pending sem confirmação",
  }),
};
