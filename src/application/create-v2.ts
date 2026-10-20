import { z } from "zod";
import { DURATION_TARGETS, TARGET_DURATIONS, type TargetDuration } from "@/config/duration-targets";
import { PRESET_ORDER, type PresetQuality } from "@/config/quality-presets";
import { SIMPLE_UGC_QUALITY_PRESETS, withTargetDuration } from "@/config/simple-presets";
import { DEFAULT_SPEAKER_PROFILE_ID } from "@/config/voices";
import { estimateDurationCost, resolvePricing } from "@/costs/calculate";
import type { PricingCatalog } from "@/costs/pricing-catalog";
import { avatarSnapshot, SAFE_AVATAR_ID, type AvatarSelection } from "@/domain/avatar";
import { selectAvatar } from "@/domain/avatar-selection";
import type { CostBudget } from "@/domain/cost";
import type { QualitySettings } from "@/domain/quality";
import type { CampaignRequest } from "@/domain/pipeline";
import { SAFE_PRODUCT_ID, STORED_IMAGE_NAME } from "@/domain/upload";
import { UgcEnvironmentChoiceSchema } from "@/domain/ugc";
import { VoiceLockRequestSchema } from "@/domain/video-speech";
import type { AvatarLibraryStore } from "@/storage/avatar-store";
import { listVoiceProfiles } from "./avatar-actions";
import type { ActionResult, AppDeps } from "./campaign-actions";
import { toUserError } from "./user-errors";

type UgcPricingRefs = NonNullable<QualitySettings["ugc"]>;

/**
 * Lote 6 — "Gerar vídeo" da UX V2. O usuário informa só: foto + nome do produto, ideia, avatar
 * (Automático/salvo) e duração (30/45/60s). Tudo o resto tem padrão seguro; "Personalizar" e
 * "Configurações avançadas" são opcionais. Toda a proteção de custo do pipeline continua valendo.
 */

export const V2_STYLES = { ugc_natural: "UGC Natural" } as const;

export const CreateV2InputSchema = z.object({
  productId: z.string().regex(SAFE_PRODUCT_ID, "Identificador do produto inválido."),
  name: z.string().trim().min(1, "Informe o nome do produto.").max(120, "Nome com até 120 caracteres."),
  imageIds: z.array(z.string().regex(STORED_IMAGE_NAME, "Imagem inválida.")).min(1, "Envie ao menos uma foto do produto.").max(6),
  idea: z.string().trim().min(3, "Conte em poucas palavras o que você quer criar.").max(2000),
  avatar: z.union([z.literal("auto"), z.string().regex(SAFE_AVATAR_ID, "Escolha um avatar da lista.")]).default("auto"),
  duration: z.union([z.literal(30), z.literal(45), z.literal(60)], { message: "Escolha 30s, 45s ou 60s." }),
  style: z.enum(["ugc_natural"]).default("ugc_natural"),
  personalize: z.object({
    gender: z.enum(["auto", "woman", "man"]).optional(),
    environment: UgcEnvironmentChoiceSchema.optional(),
    environmentText: z.string().trim().max(160).optional(),
    tone: z.string().trim().max(120).optional(),
    cta: z.string().trim().max(200).optional(),
  }).optional(),
  advanced: z.object({
    quality: z.enum(PRESET_ORDER as unknown as [PresetQuality, ...PresetQuality[]]).optional(),
    voiceLock: VoiceLockRequestSchema.optional(),
  }).optional(),
});
export type CreateV2Input = z.input<typeof CreateV2InputSchema>;

/** Campos obrigatórios da UX V2 (o resto é opcional). */
export const CREATE_V2_REQUIRED_FIELDS = ["imageIds", "name", "idea", "duration"] as const;

export interface CreateV2Deps extends AppDeps {
  avatars?: AvatarLibraryStore;
  defaultBudget: CostBudget;
}

function fieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  for (const issue of issues) errors[issue.path.map(String).join(".") || "form"] ??= issue.message;
  return errors;
}

/** Automático → seleção por tags; avatar escolhido → revisão atual congelada; sem avatar → sintética. */
export async function resolveAvatarSelection(
  avatars: AvatarLibraryStore | undefined,
  choice: "auto" | string,
  product: { name: string; description: string },
): Promise<AvatarSelection> {
  if (!avatars) return { mode: "synthetic", reason: "Biblioteca de avatares indisponível: apresentadora sintética gerada automaticamente.", matchedTags: [] };
  if (choice !== "auto") {
    const current = (await avatars.getAvatarRecord(choice)).current;
    if (current.archived || !current.active) throw new Error(`O avatar ${current.name} está desativado. Ative-o em Avatares ou escolha outro.`);
    return { mode: "manual", avatarId: current.id, avatarRevision: current.revision, reason: `${current.name} escolhido por você.`, matchedTags: [], snapshot: avatarSnapshot(current) };
  }
  const list = await avatars.listAvatars();
  const selection = selectAvatar(list, product);
  if (selection.mode !== "auto") return selection;
  const chosen = list.find((a) => a.id === selection.avatarId)!;
  return { ...selection, snapshot: avatarSnapshot(chosen) };
}

export async function startVideoV2(deps: CreateV2Deps, input: unknown): Promise<ActionResult<{ campaignId: string; avatarReason: string }>> {
  const parsed = CreateV2InputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", title: "Falta pouco", message: "Revise os campos destacados.", retryable: false }, fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const v = parsed.data;
  try {
    const stored = await deps.uploads.resolve(v.productId, v.imageIds);
    if (stored.length !== v.imageIds.length) {
      return { ok: false, error: { code: "validation", title: "Revise as fotos", message: "Uma das fotos não existe mais.", retryable: false }, fieldErrors: { imageIds: "Uma das fotos não foi encontrada. Envie de novo." } };
    }
    const description = v.idea;
    const selection = await resolveAvatarSelection(deps.avatars, v.avatar, { name: v.name, description });
    const snapshot = selection.snapshot;
    const voices = await listVoiceProfiles(deps);
    const voice = snapshot?.voiceProfileId ? voices.find((p) => p.id === snapshot.voiceProfileId) : undefined;
    const gender = snapshot?.gender ?? v.personalize?.gender ?? "auto";
    const speakerProfileId = voice?.speakerProfileId ?? (gender === "man" ? "rafael" : DEFAULT_SPEAKER_PROFILE_ID);
    const request: CampaignRequest = {
      simpleFlow: true,
      uxVersion: 2,
      projectName: v.name,
      videoConcept: v.idea,
      product: {
        id: v.productId, name: v.name,
        // A ideia é direção criativa (videoConcept), não fato do produto.
        description: `${v.name} — informações detalhadas não fornecidas.`,
        features: [], benefits: [],
        images: stored.map((s, i) => ({ id: s.id, uri: s.uri, alt: `${v.name} — foto ${i + 1}` })),
      },
      styles: ["ugc"], styleSelection: "manual", creativeCount: 1,
      quality: v.advanced?.quality ?? "high",
      budget: deps.defaultBudget,
      speakerProfileId,
      creativeMode: "ai_ugc",
      ugc: { presenter: gender, environment: v.personalize?.environment ?? "auto", visualStyle: "natural_smartphone" },
      targetDurationSeconds: v.duration,
      avatar: selection,
      ...(v.personalize && (v.personalize.tone || v.personalize.cta || v.personalize.environmentText)
        ? { personalization: { tone: v.personalize.tone, cta: v.personalize.cta, environmentText: v.personalize.environmentText, style: V2_STYLES[v.style] } } : {}),
      voiceLock: v.advanced?.voiceLock ?? "auto",
    };
    const { campaign, completion } = await deps.service.startPlanning(request);
    completion.catch((error: unknown) => console.error(`[planejamento ${campaign.id}]`, error));
    return { ok: true, value: { campaignId: campaign.id, avatarReason: selection.reason } };
  } catch (error) {
    return { ok: false, error: toUserError(error) };
  }
}

// ---------------------------------------------------------------- estimativa antes de gerar

export interface V2EstimateView {
  duration: TargetDuration;
  quality: PresetQuality;
  clips: number;
  totalBrl: number;
  lines: { label: string; brl: number }[];
  provisional: boolean;
}

/** Tabela de estimativas (duração × qualidade) para "Estimativa: R$ XX,XX" antes do botão Gerar. */
export function v2Estimates(catalog: PricingCatalog, exchangeRate: number, ugcChoice?: (q: PresetQuality) => UgcPricingRefs): V2EstimateView[] {
  return TARGET_DURATIONS.flatMap((duration) => PRESET_ORDER.map((quality) => {
    const target = DURATION_TARGETS[duration];
    const base = SIMPLE_UGC_QUALITY_PRESETS[quality];
    const settings = withTargetDuration(ugcChoice ? { ...base, ugc: ugcChoice(quality) } : base, target);
    const estimate = estimateDurationCost(settings, resolvePricing(settings, catalog), exchangeRate, target.clips, target.finalVideoSeconds.max);
    return { duration, quality, clips: target.clips, totalBrl: estimate.total.brl, lines: estimate.lines, provisional: estimate.containsPlaceholderPrices };
  }));
}

/** Custos-base para estimar um pedido de mudança (ChangeRequest) a partir da tabela V2. */
export function changeRequestCosts(estimates: readonly V2EstimateView[], duration: TargetDuration, quality: PresetQuality, lockedVoice: boolean) {
  const entry = estimates.find((e) => e.duration === duration && e.quality === quality) ?? estimates[0]!;
  const line = (prefix: string) => entry.lines.find((l) => l.label.startsWith(prefix))?.brl ?? 0;
  return {
    clipBrl: entry.clips > 0 ? line("Vídeo") / entry.clips : 0,
    clips: entry.clips,
    // Fala nativa: não há narração separada para refazer.
    narrationBrl: lockedVoice ? line("Roteiro") : 0,
    scriptBrl: line("Roteiro"),
    referenceBrl: line("Apresentadora"),
  };
}
