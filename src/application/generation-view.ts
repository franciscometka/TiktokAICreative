import { actualCreditsFromBrl, estimatedCreditsFromBrl } from "@/costs/credits";
import type { WorkerStatusView } from "./worker-status";
import type { CampaignView, CreativeView, SceneView } from "./campaign-view";
import type { ProjectV2View } from "./project-v2-view";

/**
 * L8.5 — tela de geração (Cinematic). Pura: monta o que a tela afirma SOMENTE a partir de dados
 * reais (fase do ProjectV2View, status das cenas, `activity.phase`, Product Fidelity, ledger,
 * cotações e worker). Regras:
 * - nenhuma porcentagem global: progresso por ETAPAS reais; a única barra numérica é
 *   "cenas prontas / cenas planejadas" (contagem real; fórmula em `sceneProgress`);
 * - "Gerando cena N de M" só com cenas planejadas; N = primeira cena ainda não pronta (o pipeline
 *   gera as cenas em sequência — `pipeline-service.ts`, laço por cena do estágio);
 * - mensagens contextuais só quando o fato existe (avatar com foto, especificações, cena atual,
 *   render); senão, nenhuma;
 * - créditos: real = ledger (nunca mock); estimativa sempre "~"; sem custo real → só a estimativa.
 */

export type GenerationKind =
  | "awaiting_planning_approval" | "awaiting_approval" | "queued" | "planning" | "reference" | "fidelity"
  | "generating" | "rendering" | "done" | "simulated_done" | "scene_failed" | "job_failed" | "planning_failed" | "blocked";

export type StageState = "completed" | "active" | "upcoming" | "failed" | "attention";
export type StageId = "script" | "reference" | "fidelity" | "scenes" | "render";

/** Etapas REAIS da geração V2 (AI UGC): roteiro → referência → conferência → cenas → montagem. */
export const GENERATION_STAGES: readonly { id: StageId; label: string }[] = [
  { id: "script", label: "Roteiro" },
  { id: "reference", label: "Referência visual" },
  { id: "fidelity", label: "Conferência do produto" },
  { id: "scenes", label: "Cenas" },
  { id: "render", label: "Montagem final" },
];

export type SceneStatus = "ready" | "generating" | "waiting" | "failed";

export interface GenerationScene {
  id: string;
  number: number;
  durationSeconds: number;
  status: SceneStatus;
  /** Só quando o arquivo existe (nunca prévia inventada). */
  videoUrl: string | null;
  narration: string;
  visual: string;
  motion: string | null;
  simulated: boolean;
}

export type GenerationCredits =
  | { mode: "progress"; real: number; estimated: number }
  | { mode: "estimate"; estimated: number }
  | { mode: "final"; used: number };

export type GenerationPreview =
  | { kind: "final"; url: string; downloadUrl: string }
  | { kind: "scene"; url: string; sceneNumber: number }
  | { kind: "none" };

export interface GenerationAction {
  kind: "start_planning" | "authorize" | "retry_scene" | "retry_job" | "retry_planning";
  label: string;
  credits: number | null;
  disabled: boolean;
}

export interface GenerationView {
  kind: GenerationKind;
  title: string;
  headline: string;
  subtext: string | null;
  tone: "progress" | "attention" | "success" | "danger" | "warning" | "neutral";
  stages: { id: StageId; label: string; state: StageState }[];
  scenes: GenerationScene[];
  /** "Gerando cena 3 de 5" — null sem cenas planejadas ou fora da etapa de cenas. */
  sceneCounter: string | null;
  sceneProgress: { ready: number; total: number } | null;
  context: string | null;
  preview: GenerationPreview;
  credits: GenerationCredits | null;
  action: GenerationAction | null;
  /** Motivo técnico sanitizado (só em "Ver detalhes"). */
  details: string | null;
  summary: { label: string; value: string }[];
}

// ---------------------------------------------------------------- entrada (recorte do CampaignView)

export interface GenerationSource {
  v2: ProjectV2View;
  qualityLabel: string;
  targetDurationSeconds: number | null;
  scenes: Pick<SceneView, "id" | "number" | "startSeconds" | "endSeconds" | "status" | "videoUrl" | "narration" | "visualDescription" | "motionLabel" | "visualSource" | "isGenerated" | "simulated">[];
  activityPhase: "generating" | "rendering" | null;
  presenterReady: boolean;
  identity: { strategy: string; avatarName: string | null } | null;
  specsCount: number;
  uncertainPaidOperation: string | null;
  authorization: { status: string; estimatedBrl?: number; baselineActualBrl?: number } | null;
  jobQuote: { estimatedBrl: number; ready: boolean } | null;
  planningQuote: { estimatedBrl: number } | null;
  actual: { totalBrl: number; simulated: boolean };
  renderDurationSeconds: number | null;
  productImageUrl: string | null;
  /** Product Fidelity Gate da referência (status e divergências), quando existe. */
  fidelity: { statusLabel: string; conflicts: string[] } | null;
}

export function generationSource(view: CampaignView, v2: ProjectV2View): GenerationSource {
  const creative: CreativeView | undefined = view.creatives[0];
  const ugc = creative?.ugc;
  return {
    v2,
    qualityLabel: view.strategy.qualityLabel,
    targetDurationSeconds: view.targetDurationSeconds ?? null,
    scenes: creative?.scenes ?? [],
    activityPhase: creative?.activity?.phase ?? null,
    presenterReady: !!ugc?.approved && ugc.fidelity?.status === "approved",
    identity: ugc ? { strategy: ugc.identity.strategy, avatarName: ugc.identity.avatarName } : null,
    specsCount: ugc?.specs.length ?? 0,
    uncertainPaidOperation: creative?.uncertainPaidOperation ?? null,
    authorization: creative?.authorization ?? null,
    jobQuote: creative?.jobQuote ? { estimatedBrl: creative.jobQuote.estimatedBrl, ready: creative.jobQuote.ready } : null,
    planningQuote: view.planningQuote ? { estimatedBrl: view.planningQuote.estimatedBrl } : null,
    actual: { totalBrl: view.costs.actual.totalBrl, simulated: view.costs.actual.simulated },
    renderDurationSeconds: creative?.latestRender?.durationSeconds ?? null,
    productImageUrl: view.product.images[0]?.previewUrl ?? null,
    fidelity: ugc?.fidelity ? { statusLabel: ugc.fidelity.statusLabel, conflicts: ugc.fidelity.conflicts } : null,
  };
}

// ---------------------------------------------------------------- regras puras

/** Cenas geradas no estágio de vídeo (AI UGC: pessoa; senão, as que exigem vídeo gerado). */
function generatedScenes(scenes: GenerationSource["scenes"]): GenerationSource["scenes"] {
  const ugc = scenes.filter((s) => s.isGenerated && s.visualSource.startsWith("ugc_"));
  return ugc.length > 0 ? ugc : scenes.filter((s) => s.isGenerated);
}

/**
 * Status visível por cena. O view model marca TODAS as cenas sem tentativa como "generating"
 * enquanto o estágio roda; como o pipeline gera uma por vez, só a primeira não pronta está de fato
 * "Gerando"; as demais aparecem "Aguardando".
 */
export function sceneItems(scenes: GenerationSource["scenes"], stageRunning: boolean): GenerationScene[] {
  const list = generatedScenes(scenes);
  const current = stageRunning ? list.find((s) => s.status !== "ready" && s.status !== "failed") : undefined;
  return list.map((s) => ({
    id: s.id, number: s.number, durationSeconds: Math.max(0, Math.round((s.endSeconds - s.startSeconds) * 10) / 10),
    status: s.status === "ready" ? "ready" : s.status === "failed" ? "failed" : current?.id === s.id ? "generating" : "waiting",
    videoUrl: s.status === "ready" && s.videoUrl ? s.videoUrl : null,
    narration: s.narration, visual: s.visualDescription, motion: s.motionLabel ?? null, simulated: s.simulated,
  }));
}

/** Barra real de cenas: prontas / planejadas (sem cenas planejadas → null). */
export function sceneProgress(scenes: readonly GenerationScene[]): { ready: number; total: number } | null {
  return scenes.length ? { ready: scenes.filter((s) => s.status === "ready").length, total: scenes.length } : null;
}

/** Prévia: vídeo final > cena pronta mais recente > nada (skeleton). */
export function previewFor(v2: ProjectV2View, scenes: readonly GenerationScene[]): GenerationPreview {
  if (v2.result) return { kind: "final", url: v2.result.videoUrl, downloadUrl: v2.result.downloadUrl };
  const ready = [...scenes].reverse().find((s) => s.videoUrl);
  return ready?.videoUrl ? { kind: "scene", url: ready.videoUrl, sceneNumber: ready.number } : { kind: "none" };
}

/** Créditos: real = ledger (mock não conta); estimativa "~" (arredondada para cima). */
export function generationCredits(source: GenerationSource, kind: GenerationKind, perBrl: number | null): GenerationCredits | null {
  if (!perBrl) return null;
  const real = source.actual.simulated ? 0 : actualCreditsFromBrl(source.actual.totalBrl, perBrl);
  if (kind === "done") return source.actual.simulated ? null : { mode: "final", used: real };
  if (kind === "simulated_done") return null;
  if (kind === "awaiting_planning_approval") return source.planningQuote?.estimatedBrl ? { mode: "estimate", estimated: estimatedCreditsFromBrl(source.planningQuote.estimatedBrl, perBrl) } : null;
  if (kind === "awaiting_approval") return source.jobQuote?.estimatedBrl ? { mode: "estimate", estimated: estimatedCreditsFromBrl(source.jobQuote.estimatedBrl, perBrl) } : null;
  const auth = source.authorization;
  const totalBrl = auth?.estimatedBrl !== undefined ? auth.estimatedBrl + (auth.baselineActualBrl ?? 0) : null;
  if (!totalBrl) return real > 0 ? { mode: "progress", real, estimated: real } : null;
  const estimated = Math.max(estimatedCreditsFromBrl(totalBrl, perBrl), real);
  // Sem custo real ainda: só a estimativa (nunca "0 / ~N" sugerindo consumo começado).
  return real > 0 ? { mode: "progress", real, estimated } : { mode: "estimate", estimated };
}

function kindOf(source: GenerationSource): GenerationKind {
  const { v2 } = source;
  switch (v2.phase) {
    case "planning_approval": return "awaiting_planning_approval";
    case "planning": return "planning";
    case "planning_failed": return "planning_failed";
    case "ready_to_generate": return "awaiting_approval";
    case "presenter_review": case "product_check": return "fidelity";
    case "done": return "done";
    case "simulated_done": return "simulated_done";
    case "failed":
      // Operação paga sem confirmação: pausa de segurança, nunca "erro com retry".
      if (source.uncertainPaidOperation) return "blocked";
      return v2.error?.sceneId ? "scene_failed" : "job_failed";
    case "generating":
      if (source.activityPhase === "rendering") return "rendering";
      return source.presenterReady ? "generating" : "reference";
  }
}

const STAGE_INDEX: Record<StageId, number> = { script: 0, reference: 1, fidelity: 2, scenes: 3, render: 4 };

function stagesFor(kind: GenerationKind, source: GenerationSource): GenerationView["stages"] {
  const at = (index: number, state: StageState): StageState[] => GENERATION_STAGES.map((_, i) => (i < index ? "completed" : i === index ? state : "upcoming"));
  const failedAt = source.presenterReady ? STAGE_INDEX.scenes : STAGE_INDEX.reference;
  const states: StageState[] = (() => {
    switch (kind) {
      case "awaiting_planning_approval": return at(0, "attention");
      case "planning": return at(0, "active");
      case "planning_failed": return at(0, "failed");
      case "awaiting_approval": return at(1, "upcoming");
      case "queued": return at(source.presenterReady ? STAGE_INDEX.scenes : STAGE_INDEX.reference, "attention");
      case "reference": return at(1, "active");
      case "fidelity": return at(2, "attention");
      case "generating": return at(3, "active");
      case "rendering": return at(4, "active");
      case "done": case "simulated_done": return GENERATION_STAGES.map(() => "completed" as const);
      case "scene_failed": return at(STAGE_INDEX.scenes, "failed");
      case "job_failed": return at(failedAt, "failed");
      case "blocked": return at(failedAt, "attention");
    }
  })();
  return GENERATION_STAGES.map((s, i) => ({ ...s, state: states[i]! }));
}

function contextFor(kind: GenerationKind, source: GenerationSource, scenes: readonly GenerationScene[]): string | null {
  if (kind === "planning") return "Escrevendo o roteiro do seu vídeo...";
  if (kind === "reference") {
    const name = source.identity?.strategy === "avatar_reference_image" ? source.identity.avatarName : null;
    if (name) return `Mantendo a identidade da ${name}...`;
    if (source.specsCount > 0) return "Preservando os detalhes do produto...";
    return null;
  }
  if (kind === "generating") {
    const current = scenes.find((s) => s.status === "generating");
    if (!current) return null;
    return current.number === 1 ? "Criando a abertura..." : `Gerando a cena ${current.number}...`;
  }
  if (kind === "rendering") return "Montando o vídeo final...";
  return null;
}

const COPY: Record<GenerationKind, { headline: string; subtext: string | null; tone: GenerationView["tone"] }> = {
  awaiting_planning_approval: { headline: "Tudo pronto para começar", subtext: "Primeiro passo: o roteiro. A geração do vídeo pede uma nova aprovação depois.", tone: "attention" },
  awaiting_approval: { headline: "Tudo pronto para começar", subtext: "O roteiro está pronto. Revise a estimativa e aprove para gerar o vídeo.", tone: "attention" },
  queued: { headline: "Seu vídeo está na fila", subtext: "O computador de geração está offline. O trabalho continua assim que ele voltar.", tone: "warning" },
  planning: { headline: "Estamos criando seu vídeo", subtext: "Acompanhe cada etapa enquanto o Creative Factory monta seu conteúdo.", tone: "progress" },
  reference: { headline: "Estamos criando seu vídeo", subtext: "Acompanhe cada etapa enquanto o Creative Factory monta seu conteúdo.", tone: "progress" },
  fidelity: { headline: "Confira antes de continuar", subtext: "A geração das cenas só começa depois da sua conferência.", tone: "attention" },
  generating: { headline: "Estamos criando seu vídeo", subtext: "Acompanhe cada etapa enquanto o Creative Factory monta seu conteúdo.", tone: "progress" },
  rendering: { headline: "Estamos criando seu vídeo", subtext: "Acompanhe cada etapa enquanto o Creative Factory monta seu conteúdo.", tone: "progress" },
  done: { headline: "Seu vídeo está pronto", subtext: null, tone: "success" },
  simulated_done: { headline: "Simulação concluída", subtext: "Nenhum vídeo real foi criado.", tone: "neutral" },
  scene_failed: { headline: "Uma cena não foi concluída", subtext: "As cenas prontas continuam salvas.", tone: "danger" },
  job_failed: { headline: "Não conseguimos continuar a geração", subtext: "O que já foi gerado continua salvo.", tone: "danger" },
  planning_failed: { headline: "Não conseguimos preparar o roteiro", subtext: null, tone: "danger" },
  blocked: { headline: "Geração pausada por segurança", subtext: "O sistema não conseguiu confirmar o resultado de uma operação paga e pausou para evitar cobrança duplicada.", tone: "warning" },
};

function actionFor(kind: GenerationKind, source: GenerationSource, perBrl: number | null): GenerationAction | null {
  const { v2 } = source;
  // Cotação zerada (só mocks) → sem número: "~0 créditos" não informa nada.
  const credits = (brl: number | undefined) => (perBrl && brl ? estimatedCreditsFromBrl(brl, perBrl) : null);
  switch (kind) {
    case "awaiting_planning_approval":
      return { kind: "start_planning", label: "Começar", credits: credits(source.planningQuote?.estimatedBrl), disabled: !v2.quoteToken };
    case "awaiting_approval":
      return { kind: "authorize", label: "Gerar vídeo", credits: credits(source.jobQuote?.estimatedBrl), disabled: !v2.quoteToken || !v2.jobId };
    case "planning_failed":
      if (v2.error?.retry === "planning_approval") return { kind: "start_planning", label: "Tentar novamente", credits: credits(v2.estimate?.brl), disabled: !v2.quoteToken };
      return { kind: "retry_planning", label: "Tentar novamente", credits: null, disabled: false };
    case "scene_failed":
    case "job_failed":
      // Só ações que JÁ existem: cotação da cena (quando houver) ou nova autorização do job com a
      // cotação atual pronta. Sem cotação utilizável → nenhum botão.
      if (v2.error?.retry === "scene" && v2.error.sceneToken && v2.jobId) return { kind: "retry_scene", label: "Tentar novamente", credits: null, disabled: false };
      if (v2.jobId && v2.quoteToken && source.jobQuote?.ready) return { kind: "retry_job", label: "Tentar novamente", credits: credits(source.jobQuote.estimatedBrl), disabled: false };
      return null;
    default:
      return null;
  }
}

function summaryFor(source: GenerationSource): GenerationView["summary"] {
  const duration = source.renderDurationSeconds ?? source.targetDurationSeconds;
  return [
    ...(source.v2.avatar ? [{ label: "Avatar", value: source.v2.avatar.name ?? (source.v2.avatar.label.startsWith("Apresentadora gerada") ? "Gerada automaticamente" : source.v2.avatar.label) }] : []),
    ...(duration ? [{ label: "Duração", value: source.renderDurationSeconds ? source.v2.result?.durationLabel ?? `${Math.round(duration)}s` : `${duration}s` }] : []),
    { label: "Qualidade", value: source.qualityLabel },
  ];
}

export interface GenerationContext {
  /** null = créditos não configurados (sem números). */
  creditsPerBrl: number | null;
}

export function buildGenerationView(source: GenerationSource, ctx: GenerationContext): GenerationView {
  const kind = kindOf(source);
  const stageRunning = kind === "generating";
  const scenes = sceneItems(source.scenes, stageRunning);
  const current = scenes.find((s) => s.status === "generating");
  const copy = COPY[kind];
  const failedScene = kind === "scene_failed" ? scenes.find((s) => s.status === "failed") : undefined;
  return {
    kind,
    title: source.v2.title,
    headline: failedScene ? `Cena ${failedScene.number} não foi concluída` : copy.headline,
    // Sem afirmar a causa: o motivo técnico real fica em "Ver detalhes".
    subtext: copy.subtext,
    tone: copy.tone,
    stages: stagesFor(kind, source),
    scenes,
    sceneCounter: stageRunning && current ? `Gerando cena ${current.number} de ${scenes.length}` : null,
    sceneProgress: sceneProgress(scenes),
    context: contextFor(kind, source, scenes),
    preview: previewFor(source.v2, scenes),
    credits: generationCredits(source, kind, ctx.creditsPerBrl),
    action: actionFor(kind, source, ctx.creditsPerBrl),
    details: kind === "blocked" ? [source.uncertainPaidOperation, source.v2.error?.details].filter(Boolean).join(" · ") : source.v2.error?.details ?? null,
    summary: summaryFor(source),
  };
}

/**
 * Worker (cloud): o job precisa do worker e ele está offline → "na fila" (âmbar), nunca erro.
 * "unknown" não vira offline: a tela só avisa que o status não foi verificado.
 */
export function withWorker(view: GenerationView, worker: WorkerStatusView | null): GenerationView & { workerNotice: "unknown" | null } {
  const needsWorker = view.kind === "planning" || view.kind === "reference" || view.kind === "generating" || view.kind === "rendering";
  if (needsWorker && worker?.state === "offline") {
    const copy = COPY.queued;
    // A etapa em andamento fica "aguardando" (âmbar); nada é marcado como falha.
    return { ...view, kind: "queued", headline: copy.headline, subtext: copy.subtext, tone: copy.tone, context: null, sceneCounter: null, workerNotice: null,
      stages: view.stages.map((s) => (s.state === "active" ? { ...s, state: "attention" as const } : s)),
      scenes: view.scenes.map((s) => (s.status === "generating" ? { ...s, status: "waiting" as const } : s)) };
  }
  return { ...view, workerNotice: needsWorker && worker?.state === "unknown" ? "unknown" : null };
}
