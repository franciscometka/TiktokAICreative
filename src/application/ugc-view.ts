import { previewEditorialTimeline } from "@/ai/ugc-editorial";
import { UGC_ROLE_ACTIONS } from "@/ai/ugc-script";
import type { CutReason } from "@/domain/edit";
import type { FidelityConstraint, FidelityStatus } from "@/domain/fidelity";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import type { ScenePlan } from "@/domain/creative";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import {
  approvedReference,
  isUgcPersonSource,
  referenceFidelityStatus,
  latestReference,
  UGC_ENVIRONMENTS,
  type UgcEnvironment,
  type UgcReference,
  ugcReferenceLabels,
} from "@/domain/ugc";

/**
 * View model do AI UGC (serializável). Diz ao usuário, ANTES de qualquer vídeo pago:
 * quem aparece, o que segura, o que fala e o que faz. Nada de caminho de disco ou segredo:
 * imagens reais por IDs (/api/ugc/...); no mock, a foto do produto com selo "MOCK".
 */

export interface UgcReferenceView {
  id: string;
  /** Versão técnica (pasta em disco / rota). Não exibir: use `label`. */
  version: string;
  /** Rótulo exibido: "v1", "v2"… para REAIS; "Simulação" para MOCK histórico. */
  label: string;
  state: UgcReference["state"];
  review: UgcReference["review"];
  isMock: boolean;
  /** Real: /api/ugc/...; mock: foto do produto (a UI marca "MOCK · referência simulada"). */
  previewUrl: string | null;
  createdAt: string;
  error?: string;
}

export interface UgcView {
  headline: string;
  /** Lote 5.5: há referência MOCK (histórico/simulação) que não serve para o fluxo REAL. */
  historicalSimulation: boolean;
  /** Oferecer "Gerar referência real" (projeto antigo MOCK no fluxo REAL-only). */
  canGenerateReal: boolean;
  /** Status curto do que está rodando agora (null = nada em andamento). */
  progressLabel: string | null;
  person: { genderLabel: string; appearance: string; wardrobe: string; environment: UgcEnvironment; environmentLabel: string; visualStyle: string };
  product: { name: string; previewUrl: string | null; preserve: string[] };
  audioStrategy: "native_speech" | "external_lipsync";
  audioStrategyLabel: string;
  current?: UgcReferenceView;
  approved?: UgcReferenceView;
  history: UgcReferenceView[];
  /** Referência pronta esperando "Aprovar" (o job fica pausado nesta decisão). */
  awaitingApproval: boolean;
  canApprove: boolean;
  canRegenerate: boolean;
  /** Trocar apresentador/ambiente só antes de existir cena UGC gerada. */
  canChangeIdentity: boolean;
  environments: { id: UgcEnvironment; label: string }[];
  attemptsUsed: number;
  /** Product Fidelity Gate da referência atual/aprovada. */
  fidelity?: { status: FidelityStatus; statusLabel: string; checklist: string[]; conflicts: string[] };
  /** Referência já aprovada (ex.: projeto antigo) cuja fidelidade ainda não foi confirmada. */
  canConfirmFidelity: boolean;
  /** Storyboard V2: trechos A-roll/B-roll na timeline final planejada. */
  editorial: EditorialItemView[];
  /** Depois do render V2: segundos gerados (pagos) × usados no corte, por clipe. */
  usage: { sceneId: string; label: string }[];
}

export interface EditorialItemView {
  sceneId: string;
  roleLabel: "A-ROLL" | "B-ROLL";
  range: string;
  durationLabel: string;
  speech: string;
  visual: string;
  cutReasonLabel: string;
  audioNote: string | null;
  continuity: string | null;
  status: string;
}

const CUT_REASON_LABELS: Record<CutReason, string> = {
  opening: "Abertura", sentence_boundary: "Fim de frase", action_match: "Continua o gesto", product_reveal: "Mostra o produto",
  detail_emphasis: "Destaca um detalhe", hand_occlusion: "Mão passa pela câmera", camera_motion: "Movimento de câmera",
  hook_emphasis: "Reforça o gancho", cta_return: "Volta para a chamada final",
};

const FIDELITY_LABELS: Record<FidelityStatus, string> = { pending: "Aguardando revisão", approved: "Fiel ao produto", rejected: "Reprovada", needs_review: "Divergência encontrada" };

const seconds = (n: number) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(n)}s`;

function checklistFor(constraints: readonly FidelityConstraint[]): string[] {
  return constraints.map((c) => c.kind === "number" || c.kind === "model" ? `Texto/número exato: ${c.expected}` : c.kind === "text" ? `Nome: ${c.expected}` : c.expected);
}

export interface UgcSceneInfo {
  role: string;
  who: string;
  holding: string;
  speech: string;
  action: string;
}

export function ugcReferenceUrl(campaignId: string, creativeId: string, version: string): string {
  return `/api/ugc/${encodeURIComponent(campaignId)}/${encodeURIComponent(creativeId)}/${encodeURIComponent(version)}`;
}

export function buildUgcView(input: {
  campaign: Campaign;
  creativeId: string;
  job: GenerationJob | undefined;
  active: boolean;
  productPreviewUrl: string | null;
}): UgcView | undefined {
  const { campaign, job } = input;
  const state = job?.ugc;
  if (campaign.request.creativeMode !== "ai_ugc" || !state || !job) return undefined;
  const labels = ugcReferenceLabels(state.references);
  const toView = (r: UgcReference): UgcReferenceView => ({
    id: r.id,
    version: r.version,
    label: labels.get(r.id) ?? r.version,
    state: r.state,
    review: r.review,
    isMock: r.isMock,
    previewUrl: r.state !== "succeeded" ? null : r.isMock ? input.productPreviewUrl : ugcReferenceUrl(campaign.id, input.creativeId, r.version),
    createdAt: r.createdAt,
    error: r.error,
  });
  const latest = latestReference(state);
  const current = latest && latest.identityId === state.identity.id && latest.identityRevision === state.identity.revision ? latest : undefined;
  const approved = approvedReference(state);
  const ugcScenesExist = job.scenes.some((s) => s.attempts.some((a) => a.ugc));
  const awaitingApproval = current?.state === "succeeded" && current.review === "pending";
  const identity = state.identity;
  const reviewed = current ?? approved;
  const constraints = reviewed?.fidelity?.constraints ?? state.product.fidelityConstraints ?? [];
  const fidelityStatus = referenceFidelityStatus(reviewed);
  const plan = campaign.plan?.creatives.find((c) => c.id === input.creativeId);
  const sceneState = (sceneId: string) => {
    const attempts = job.scenes.find((s) => s.sceneId === sceneId)?.attempts ?? [];
    const last = attempts[attempts.length - 1];
    return !last ? "Planejado" : last.status === "succeeded" ? "Gerado" : last.status === "failed" ? "Falhou" : "Em andamento";
  };
  const editorial: EditorialItemView[] = plan ? previewEditorialTimeline(plan).map((item) => ({
    sceneId: item.sceneId,
    roleLabel: item.role === "aroll" ? "A-ROLL" : "B-ROLL",
    range: `${seconds(item.startSeconds)}–${seconds(item.endSeconds)}`,
    durationLabel: seconds(item.endSeconds - item.startSeconds),
    speech: item.speech,
    visual: item.visual,
    cutReasonLabel: CUT_REASON_LABELS[item.cutReason],
    audioNote: item.role === "broll" ? "Áudio continua da apresentadora" : null,
    continuity: item.continuity ?? null,
    status: item.role === "broll" ? "Sem custo extra (frame da referência)" : sceneState(item.sceneId),
  })) : [];
  const usage = (job.manifest?.edit?.usage ?? []).map((u) => ({ sceneId: u.sceneId, label: `${seconds(u.generatedSeconds)} gerados · ${seconds(u.usedSeconds)} usados` }));
  return {
    headline: "Esta será a pessoa apresentando seu produto",
    historicalSimulation: false,
    canGenerateReal: false,
    progressLabel: !input.active ? null
      : job.currentStage === "ugc_video" ? "Gerando cena UGC..."
      : job.currentStage === "ugc_reference" || current?.state === "submitting" || current?.state === "pending" ? "Gerando apresentador com seu produto..." : null,
    person: {
      genderLabel: identity.gender === "woman" ? "Mulher" : "Homem",
      appearance: identity.appearance,
      wardrobe: identity.wardrobe,
      environment: identity.environment,
      environmentLabel: UGC_ENVIRONMENT_LABELS[identity.environment].label,
      visualStyle: identity.visualStyle,
    },
    product: { name: state.product.name, previewUrl: input.productPreviewUrl, preserve: state.product.preserve },
    audioStrategy: state.audioStrategy,
    audioStrategyLabel: state.audioStrategy === "native_speech" ? "Fala gerada pelo próprio vídeo (sem narração separada)" : "Narração ElevenLabs + sincronização labial",
    current: current ? toView(current) : undefined,
    approved: approved ? toView(approved) : undefined,
    history: state.references.map(toView).reverse(),
    awaitingApproval,
    canApprove: awaitingApproval && !input.active,
    canRegenerate: !input.active && !ugcScenesExist && !!current && current.state !== "submitting" && current.state !== "pending" && current.state !== "uncertain",
    canChangeIdentity: !input.active && !ugcScenesExist,
    environments: UGC_ENVIRONMENTS.map((id) => ({ id, label: UGC_ENVIRONMENT_LABELS[id].label })),
    attemptsUsed: state.references.length,
    fidelity: reviewed ? { status: fidelityStatus, statusLabel: FIDELITY_LABELS[fidelityStatus], checklist: checklistFor(constraints), conflicts: (reviewed.fidelity?.conflicts ?? []).map((c) => `esperado ${c.expected}, observado ${c.observed}`) } : undefined,
    canConfirmFidelity: !input.active && !!approved && current?.id === approved.id && fidelityStatus !== "approved",
    editorial,
    usage,
  };
}

const ROLE_LABELS: Record<string, string> = {
  ugc_hook: "Gancho",
  ugc_demo: "Demonstração",
  ugc_benefit: "Benefício",
  ugc_cta: "Chamada final",
  product_broll: "B-roll do produto",
  product_image: "Imagem do produto",
  text_card: "Texto",
};

/** Quem aparece / o que segura / o que fala / o que faz — por cena do storyboard AI UGC. */
export function ugcSceneInfo(scene: ScenePlan, job: GenerationJob | undefined): UgcSceneInfo | undefined {
  const state = job?.ugc;
  if (!state) return undefined;
  const person = isUgcPersonSource(scene.visualSource);
  const gender = state.identity.gender === "woman" ? "A mesma apresentadora" : "O mesmo apresentador";
  if (scene.visualSource === "reference_detail") {
    return { role: "B-roll · detalhe", who: "Detalhe do produto na mão (frame da referência aprovada)", holding: state.product.name, speech: "Sem fala própria: o áudio da apresentadora continua", action: scene.edit?.detail ?? scene.visualDescription };
  }
  return {
    role: ROLE_LABELS[scene.visualSource] ?? scene.visualSource,
    who: person ? `${gender} da referência (${state.identity.wardrobe})` : "Ninguém — só o produto",
    holding: person ? state.product.name : "—",
    speech: scene.narration || (state.audioStrategy === "native_speech" ? "Sem fala (fala só nas cenas UGC)" : "Sem fala"),
    action: person ? UGC_ROLE_ACTIONS[scene.visualSource as keyof typeof UGC_ROLE_ACTIONS] : scene.visualDescription,
  };
}

/**
 * Lote 5.5 (ALLOW_MOCKS=false): referência MOCK vira histórico. Sem imagem simulada, sem aprovar
 * "pessoa" que não existe; oferece gerar a referência real.
 */
export function realOnlyUgcView(view: UgcView): UgcView {
  const strip = (ref: UgcReferenceView | undefined) => (ref?.isMock ? { ...ref, previewUrl: null } : ref);
  const simulated = !!view.current?.isMock || !!view.approved?.isMock;
  return {
    ...view,
    current: strip(view.current),
    approved: view.approved?.isMock ? undefined : view.approved,
    history: view.history.map(ref => strip(ref)!),
    awaitingApproval: view.awaitingApproval && !view.current?.isMock,
    canApprove: view.canApprove && !view.current?.isMock,
    historicalSimulation: simulated,
    canGenerateReal: simulated && view.canChangeIdentity,
  };
}
