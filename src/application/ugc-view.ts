import { UGC_ROLE_ACTIONS } from "@/ai/ugc-script";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import type { ScenePlan } from "@/domain/creative";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import {
  approvedReference,
  isUgcPersonSource,
  latestReference,
  UGC_ENVIRONMENTS,
  type UgcEnvironment,
  type UgcReference,
} from "@/domain/ugc";

/**
 * View model do AI UGC (serializável). Diz ao usuário, ANTES de qualquer vídeo pago:
 * quem aparece, o que segura, o que fala e o que faz. Nada de caminho de disco ou segredo:
 * imagens reais por IDs (/api/ugc/...); no mock, a foto do produto com selo "MOCK".
 */

export interface UgcReferenceView {
  id: string;
  version: string;
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
  const toView = (r: UgcReference): UgcReferenceView => ({
    id: r.id,
    version: r.version,
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
  return {
    headline: "Esta será a pessoa apresentando seu produto",
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
    canRegenerate: !input.active && !ugcScenesExist && !!current && current.state !== "submitting" && current.state !== "pending",
    canChangeIdentity: !input.active && !ugcScenesExist,
    environments: UGC_ENVIRONMENTS.map((id) => ({ id, label: UGC_ENVIRONMENT_LABELS[id].label })),
    attemptsUsed: state.references.length,
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
  return {
    role: ROLE_LABELS[scene.visualSource] ?? scene.visualSource,
    who: person ? `${gender} da referência (${state.identity.wardrobe})` : "Ninguém — só o produto",
    holding: person ? state.product.name : "—",
    speech: scene.narration || (state.audioStrategy === "native_speech" ? "Sem fala (fala só nas cenas UGC)" : "Sem fala"),
    action: person ? UGC_ROLE_ACTIONS[scene.visualSource as keyof typeof UGC_ROLE_ACTIONS] : scene.visualDescription,
  };
}
