import { TARGET_DURATIONS, type TargetDuration } from "@/config/duration-targets";
import { PRESET_ORDER, type PresetQuality } from "@/config/quality-presets";
import { creditsFromEstimate, remainingAfter } from "@/costs/credits";
import type { Avatar } from "@/domain/avatar";
import { selectAvatar } from "@/domain/avatar-selection";
import { UGC_ENVIRONMENTS, type UgcEnvironment } from "@/domain/ugc";
import { SAFE_PRODUCT_ID, STORED_IMAGE_NAME } from "@/domain/upload";
import { imagePreviewUrl, type ImageView } from "./campaign-view";
import type { CreateV2Input, V2EstimateView } from "./create-v2";
import { DEFAULT_STYLE_PRESET, isStylePresetId, stylePreset, type StylePresetId } from "./style-presets";

/**
 * L8.4 — Create em 4 passos (Produto · Avatar · Estilo · Revisão). UMA fonte de verdade para o
 * rascunho: este reducer puro (sem state manager global). No fim, o rascunho vira exatamente o
 * mesmo `CreateV2Input` do Create antigo e vai para a mesma Server Action (`startVideoV2Action`):
 * criar projeto NÃO autoriza gasto; o projeto abre esperando a aprovação explícita de sempre.
 */

export type CreateStep = "product" | "avatar" | "style" | "review";

export const CREATE_STEPS: readonly { id: CreateStep; number: string; label: string }[] = [
  { id: "product", number: "01", label: "Produto" },
  { id: "avatar", number: "02", label: "Avatar" },
  { id: "style", number: "03", label: "Estilo" },
  { id: "review", number: "04", label: "Revisão" },
];

/** Nomes de qualidade em TODA a UI. Os valores internos continuam economy/high/premium. */
export const QUALITY_OPTIONS: readonly { value: PresetQuality; label: string }[] = [
  { value: "economy", label: "Econômico" },
  { value: "high", label: "Equilibrado" },
  { value: "premium", label: "Premium" },
];

export function qualityLabel(quality: PresetQuality): string {
  return QUALITY_OPTIONS.find((q) => q.value === quality)?.label ?? quality;
}

export type Gender = "auto" | "woman" | "man";
export type VoiceLock = "auto" | "locked" | "native";

export interface CreateDraft {
  productId: string;
  images: ImageView[];
  name: string;
  idea: string;
  /** "auto" = escolha automática (seleção por tags já existente no servidor). */
  avatar: string;
  preset: StylePresetId;
  duration: TargetDuration;
  quality: PresetQuality;
  tone: string;
  cta: string;
  gender: Gender;
  environment: "auto" | UgcEnvironment;
  voiceLock: VoiceLock;
}

export type DraftErrors = Partial<Record<"images" | "name" | "idea" | "avatar" | "duration" | "quality", string>>;

export interface CreateFlowState {
  step: CreateStep;
  draft: CreateDraft;
  errors: DraftErrors;
}

export type CreateFlowAction =
  | { type: "set"; patch: Partial<CreateDraft> }
  | { type: "preset"; id: StylePresetId }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: CreateStep }
  | { type: "serverErrors"; errors: Partial<Record<string, string>> };

const STEP_FIELDS: Record<CreateStep, (keyof DraftErrors)[]> = {
  product: ["images", "name", "idea"],
  avatar: ["avatar"],
  style: ["duration", "quality"],
  review: [],
};

export function validateStep(step: CreateStep, draft: CreateDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (step === "product") {
    if (draft.images.length === 0) errors.images = "Envie uma foto do produto.";
    if (!draft.name.trim()) errors.name = "Informe o nome do produto.";
    if (draft.idea.trim().length < 3) errors.idea = "Conte em poucas palavras o que você quer criar.";
  }
  if (step === "avatar" && !draft.avatar) errors.avatar = "Escolha um avatar ou a escolha automática.";
  if (step === "style") {
    if (!TARGET_DURATIONS.includes(draft.duration)) errors.duration = "Escolha 30s, 45s ou 60s.";
    if (!PRESET_ORDER.includes(draft.quality)) errors.quality = "Escolha a qualidade.";
  }
  return errors;
}

const stepIndex = (step: CreateStep) => CREATE_STEPS.findIndex((s) => s.id === step);

/** Primeiro passo com problema (ou null). */
export function firstInvalidStep(draft: CreateDraft): CreateStep | null {
  return CREATE_STEPS.find((s) => Object.keys(validateStep(s.id, draft)).length > 0)?.id ?? null;
}

function withoutErrors(errors: DraftErrors, patch: Partial<CreateDraft>): DraftErrors {
  const next = { ...errors };
  if ("images" in patch) delete next.images;
  if ("name" in patch) delete next.name;
  if ("idea" in patch) delete next.idea;
  if ("avatar" in patch) delete next.avatar;
  if ("duration" in patch) delete next.duration;
  if ("quality" in patch) delete next.quality;
  return next;
}

export function createFlowReducer(state: CreateFlowState, action: CreateFlowAction): CreateFlowState {
  switch (action.type) {
    case "set":
      return { ...state, draft: { ...state.draft, ...action.patch }, errors: withoutErrors(state.errors, action.patch) };
    case "preset": {
      // Preset só PREENCHE campos existentes (tom, CTA, duração) — nada de pipeline novo.
      const p = stylePreset(action.id);
      return { ...state, draft: { ...state.draft, preset: p.id, tone: p.tone, cta: p.cta, duration: p.duration }, errors: withoutErrors(state.errors, { duration: p.duration }) };
    }
    case "next": {
      const errors = validateStep(state.step, state.draft);
      if (Object.keys(errors).length > 0) return { ...state, errors };
      const next = CREATE_STEPS[Math.min(stepIndex(state.step) + 1, CREATE_STEPS.length - 1)]!.id;
      return { ...state, step: next, errors: {} };
    }
    case "back":
      return { ...state, step: CREATE_STEPS[Math.max(stepIndex(state.step) - 1, 0)]!.id, errors: {} };
    case "goto": {
      // Para trás: livre. Para frente: só se todos os passos anteriores estiverem válidos.
      const target = stepIndex(action.step);
      if (target <= stepIndex(state.step)) return { ...state, step: action.step, errors: {} };
      const blocked = CREATE_STEPS.slice(0, target).find((s) => Object.keys(validateStep(s.id, state.draft)).length > 0);
      if (blocked) return { ...state, step: blocked.id, errors: validateStep(blocked.id, state.draft) };
      return { ...state, step: action.step, errors: {} };
    }
    case "serverErrors": {
      // Erros do servidor (mesma validação do Create antigo) levam ao passo do campo.
      const errors: DraftErrors = {
        ...(action.errors.imageIds ? { images: action.errors.imageIds } : {}),
        ...(action.errors.name ? { name: action.errors.name } : {}),
        ...(action.errors.idea ? { idea: action.errors.idea } : {}),
        ...(action.errors.avatar ? { avatar: action.errors.avatar } : {}),
        ...(action.errors.duration ? { duration: action.errors.duration } : {}),
      };
      const step = CREATE_STEPS.find((s) => STEP_FIELDS[s.id].some((f) => errors[f]))?.id ?? state.step;
      return { ...state, step, errors };
    }
  }
}

// ---------------------------------------------------------------- rascunho vindo da URL (Home)

type Search = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Rascunho inicial. TUDO que vem da URL é revalidado: foto (padrões de id do upload), ideia,
 * preset, avatar (só ativos da lista), duração e qualidade. Valor inválido → padrão seguro.
 * A existência real da foto é conferida de novo pelo servidor ao criar (`startVideoV2`).
 */
export function initialCreateState(input: { newProductId: string; search: Search; avatarIds: readonly string[] }): CreateFlowState {
  const { search } = input;
  const product = first(search.product);
  const image = first(search.image);
  const validImage = !!product && !!image && SAFE_PRODUCT_ID.test(product) && STORED_IMAGE_NAME.test(image);
  const previewUrl = validImage ? imagePreviewUrl(product, image) : undefined;
  const presetRaw = first(search.preset);
  const preset = stylePreset(isStylePresetId(presetRaw) ? presetRaw : DEFAULT_STYLE_PRESET);
  const avatarRaw = first(search.avatar);
  const durationRaw = Number(first(search.duration));
  const qualityRaw = first(search.quality);
  const idea = (first(search.idea) ?? "").trim().slice(0, 2000);
  return {
    step: "product",
    errors: {},
    draft: {
      productId: validImage && previewUrl ? product : input.newProductId,
      images: validImage && previewUrl ? [{ id: image, previewUrl }] : [],
      name: "",
      idea,
      avatar: avatarRaw && input.avatarIds.includes(avatarRaw) ? avatarRaw : "auto",
      preset: preset.id,
      duration: (TARGET_DURATIONS as readonly number[]).includes(durationRaw) ? (durationRaw as TargetDuration) : preset.duration,
      quality: PRESET_ORDER.includes(qualityRaw as PresetQuality) ? (qualityRaw as PresetQuality) : "high",
      tone: preset.tone,
      cta: preset.cta,
      gender: "auto",
      environment: "auto",
      voiceLock: "auto",
    },
  };
}

/** Rascunho → o MESMO input do Create antigo (`startVideoV2Action`). */
export function toCreateInput(draft: CreateDraft): CreateV2Input {
  return {
    productId: draft.productId, name: draft.name, imageIds: draft.images.map((i) => i.id), idea: draft.idea,
    avatar: draft.avatar, duration: draft.duration, style: "ugc_natural",
    personalize: {
      ...(draft.avatar === "auto" && draft.gender !== "auto" ? { gender: draft.gender } : {}),
      ...(draft.environment !== "auto" && UGC_ENVIRONMENTS.includes(draft.environment) ? { environment: draft.environment } : {}),
      ...(draft.tone.trim() ? { tone: draft.tone.trim() } : {}),
      ...(draft.cta.trim() ? { cta: draft.cta.trim() } : {}),
    },
    advanced: { quality: draft.quality, voiceLock: draft.voiceLock },
  };
}

// ---------------------------------------------------------------- escolha automática

export interface AvatarChoice {
  id: string;
  name: string;
  imageUrl: string | null;
  tags: string[];
  defaultForTags: string[];
  preferredProductCategories: string[];
  voiceName: string | null;
  revision: number;
  updatedAt: string;
}

/**
 * Prévia da "✦ Escolha automática": a MESMA `selectAvatar` que o servidor usa ao criar (nome +
 * ideia como descrição). Sem heurística nova; o servidor decide de novo na criação.
 */
export function autoAvatarPreview(avatars: readonly AvatarChoice[], product: { name: string; idea: string }): { avatar: AvatarChoice | null; reason: string; detail: string | null } {
  const library = avatars.map((a) => ({ ...a, active: true, archived: false }) as unknown as Avatar);
  const selection = selectAvatar(library, { name: product.name, description: product.idea });
  const avatar = selection.mode === "auto" ? avatars.find((a) => a.id === selection.avatarId) ?? null : null;
  const matched = selection.matchedTags;
  const detail = avatar && matched.length ? `${avatar.defaultForTags.some((t) => matched.includes(t)) ? "padrão para" : "combina com"} ${matched.join(", ")}` : null;
  return { avatar, reason: selection.reason, detail };
}

// ---------------------------------------------------------------- créditos (L8.2)

export interface CreditsReview {
  /** Estimativa (para cima) — exibir SEMPRE com "~". */
  estimated: number;
  provisional: boolean;
  /** null = créditos não configurados (a tela não inventa saldo). */
  remaining: number | null;
  after: number | null;
  insufficient: boolean;
  /** Configuração mais barata que cabe no saldo, calculada da MESMA tabela de estimativas. */
  cheaper: { duration: TargetDuration; quality: PresetQuality; estimated: number } | null;
}

export function creditsReview(input: { estimates: readonly V2EstimateView[]; duration: TargetDuration; quality: PresetQuality; credits: { perBrl: number; remaining: number | null } | null }): CreditsReview | null {
  const { estimates, credits } = input;
  const estimate = estimates.find((e) => e.duration === input.duration && e.quality === input.quality);
  if (!estimate || !credits) return null;
  const toCredits = (e: V2EstimateView) => creditsFromEstimate(e, credits.perBrl).total;
  const estimated = toCredits(estimate);
  const remaining = credits.remaining;
  const insufficient = remaining !== null && estimated > remaining;
  let cheaper: CreditsReview["cheaper"] = null;
  if (insufficient && remaining !== null) {
    // Mais perto do pedido: mesma duração com qualidade menor, depois durações menores; dentre as
    // que cabem, a mais completa (maior custo ≤ saldo). Sem cabimento honesto → nenhuma sugestão.
    const fits = estimates
      .filter((e) => !e.provisional && e.duration <= input.duration && PRESET_ORDER.indexOf(e.quality) <= PRESET_ORDER.indexOf(input.quality))
      .filter((e) => !(e.duration === input.duration && e.quality === input.quality))
      .map((e) => ({ duration: e.duration, quality: e.quality, estimated: toCredits(e) }))
      .filter((e) => e.estimated <= remaining && e.estimated < estimated)
      .sort((a, b) => b.duration - a.duration || b.estimated - a.estimated);
    cheaper = fits[0] ?? null;
  }
  return { estimated, provisional: estimate.provisional, remaining, after: remaining === null ? null : remainingAfter(remaining, estimated), insufficient, cheaper };
}
