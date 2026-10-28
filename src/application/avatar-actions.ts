import { randomUUID } from "node:crypto";
import { SPEAKER_PROFILES } from "@/config/voices";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import {
  AvatarInputSchema,
  AvatarSchema,
  identityChanged,
  normalizeTags,
  SAFE_AVATAR_ID,
  VoiceProfileSchema,
  type Avatar,
  type VoiceProfile,
} from "@/domain/avatar";
import type { UgcEnvironment } from "@/domain/ugc";
import type { AvatarLibraryStore } from "@/storage/avatar-store";
import type { UploadStore } from "@/storage/upload-store";
import { imagePreviewUrl } from "./campaign-view";
import { toUserError, type UserError } from "./user-errors";

/**
 * Casos de uso da Biblioteca de Avatares (Lote 6). Views são SEGURAS para o browser:
 * nenhum caminho de disco e nenhum voiceId de provider (`providerVoiceId` nunca sai do servidor).
 */

export interface AvatarDeps {
  avatars?: AvatarLibraryStore;
  uploads: UploadStore;
  clock?: () => string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: UserError; fieldErrors?: Partial<Record<string, string>> };

const now = (deps: AvatarDeps) => (deps.clock ?? (() => new Date().toISOString()))();

function requireStore(deps: AvatarDeps): AvatarLibraryStore {
  if (!deps.avatars) throw new Error("Biblioteca de avatares indisponível neste processo.");
  return deps.avatars;
}

export function newAvatarId(): string {
  return `avatar_${randomUUID()}`;
}

// ---------------------------------------------------------------- vozes

/** Perfis de voz embutidos (um por SpeakerProfile pt-BR). O voiceId continua só no provider. */
export function builtInVoiceProfiles(createdAt = "2026-10-20T00:00:00.000Z"): VoiceProfile[] {
  return SPEAKER_PROFILES.map((sp) => VoiceProfileSchema.parse({
    id: `voice_${sp.id}`, provider: "elevenlabs", speakerProfileId: sp.id, name: `${sp.name} BR`, language: "pt", locale: "pt-BR",
    style: sp.description, builtIn: true, enabled: true, createdAt, updatedAt: createdAt,
  }));
}

export interface VoiceProfileView {
  id: string;
  name: string;
  style: string;
  locale: string;
  provider: string;
  builtIn: boolean;
  enabled: boolean;
  stability: number;
  speed: number;
  similarity: number;
}

export function voiceProfileView(p: VoiceProfile): VoiceProfileView {
  // providerVoiceId omitido de propósito.
  return { id: p.id, name: p.name, style: p.style, locale: p.locale, provider: p.provider, builtIn: p.builtIn, enabled: p.enabled, stability: p.stability, speed: p.speed, similarity: p.similarity };
}

export async function listVoiceProfiles(deps: AvatarDeps): Promise<VoiceProfile[]> {
  const custom = deps.avatars ? await deps.avatars.listVoiceProfiles() : [];
  const builtIn = builtInVoiceProfiles().map((b) => custom.find((c) => c.id === b.id) ?? b);
  return [...builtIn, ...custom.filter((c) => !builtIn.some((b) => b.id === c.id))];
}

export async function listVoiceProfileViews(deps: AvatarDeps): Promise<VoiceProfileView[]> {
  return (await listVoiceProfiles(deps)).map(voiceProfileView);
}

/** Cria/edita um perfil de voz (base = SpeakerProfile; ajustes de estabilidade/velocidade/similaridade). */
export async function saveVoiceProfile(deps: AvatarDeps, input: unknown): Promise<Result<VoiceProfileView>> {
  try {
    const store = requireStore(deps);
    const parsed = VoiceProfileSchema.pick({ name: true, speakerProfileId: true, style: true, stability: true, speed: true, similarity: true, enabled: true })
      .extend({ id: VoiceProfileSchema.shape.id.optional() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: { code: "validation", title: "Revise a voz", message: parsed.error.issues[0]?.message ?? "Dados inválidos.", retryable: false } };
    if (!SPEAKER_PROFILES.some((s) => s.id === parsed.data.speakerProfileId)) return { ok: false, error: { code: "validation", title: "Revise a voz", message: "Escolha uma voz base da lista.", retryable: false } };
    const all = await store.listVoiceProfiles();
    const at = now(deps);
    const existing = parsed.data.id ? (await listVoiceProfiles(deps)).find((p) => p.id === parsed.data.id) : undefined;
    const profile = VoiceProfileSchema.parse({
      ...(existing ?? { id: `voice_${randomUUID()}`, provider: "elevenlabs", language: "pt", locale: "pt-BR", builtIn: false, createdAt: at }),
      ...parsed.data, id: existing?.id ?? `voice_${randomUUID()}`, updatedAt: at,
    });
    await store.saveVoiceProfiles([...all.filter((p) => p.id !== profile.id), profile]);
    return { ok: true, value: voiceProfileView(profile) };
  } catch (error) {
    return { ok: false, error: toUserError(error) };
  }
}

// ---------------------------------------------------------------- avatares

export interface AvatarView {
  id: string;
  revision: number;
  name: string;
  active: boolean;
  imageUrl: string | null;
  gender: "woman" | "man";
  genderLabel: string;
  visualAgeRange: "20s" | "30s" | "40s";
  hair: string;
  appearanceDescriptors: string;
  appearancePrompt: string;
  defaultOutfit: string;
  defaultEnvironment: string;
  environment: UgcEnvironment | null;
  environmentLabel: string | null;
  speakingStyle: string;
  personality: string;
  tags: string[];
  preferredProductCategories: string[];
  defaultForTags: string[];
  voiceProfileId: string | null;
  voiceName: string | null;
  referenceImage: { ownerId: string; imageId: string } | null;
  updatedAt: string;
}

export function avatarView(avatar: Avatar): AvatarView {
  return {
    id: avatar.id, revision: avatar.revision, name: avatar.name, active: avatar.active,
    imageUrl: avatar.referenceImage ? imagePreviewUrl(avatar.referenceImage.ownerId, avatar.referenceImage.imageId) ?? null : null,
    gender: avatar.gender, genderLabel: avatar.gender === "woman" ? "Mulher" : "Homem", visualAgeRange: avatar.visualAgeRange,
    hair: avatar.hair, appearanceDescriptors: avatar.appearanceDescriptors, appearancePrompt: avatar.appearancePrompt,
    defaultOutfit: avatar.defaultOutfit, defaultEnvironment: avatar.defaultEnvironment,
    environment: avatar.environment ?? null, environmentLabel: avatar.environment ? UGC_ENVIRONMENT_LABELS[avatar.environment].label : null,
    speakingStyle: avatar.speakingStyle, personality: avatar.personality, tags: avatar.tags, preferredProductCategories: avatar.preferredProductCategories,
    defaultForTags: avatar.defaultForTags, voiceProfileId: avatar.voiceProfileId ?? null, voiceName: avatar.voiceName ?? null,
    referenceImage: avatar.referenceImage ? { ownerId: avatar.referenceImage.ownerId, imageId: avatar.referenceImage.imageId } : null,
    updatedAt: avatar.updatedAt,
  };
}

export async function listAvatarViews(deps: AvatarDeps): Promise<AvatarView[]> {
  if (!deps.avatars) return [];
  return (await deps.avatars.listAvatars()).map(avatarView);
}

export async function getAvatarView(deps: AvatarDeps, id: string): Promise<AvatarView | undefined> {
  if (!deps.avatars || !SAFE_AVATAR_ID.test(id)) return undefined;
  try {
    return avatarView((await deps.avatars.getAvatarRecord(id)).current);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- perfil (L8.7, só leitura)

/** Resumo SEGURO de uma revisão: número, data, foto e se é a atual. O domínio não guarda motivo. */
export interface AvatarRevisionView {
  revision: number;
  current: boolean;
  /** Última gravação daquela revisão (o domínio não guarda outra data por revisão). */
  updatedAt: string;
  imageUrl: string | null;
}

export interface AvatarUsageView {
  /** Projetos cujo pedido usou este avatar (qualquer revisão). */
  count: number;
  recent: { id: string; name: string; createdAt: string; thumbnailUrl: string | null }[];
}

export interface AvatarDetailView {
  avatar: AvatarView;
  revisions: AvatarRevisionView[];
  /** null = não foi possível calcular com segurança neste processo. */
  usage: AvatarUsageView | null;
}

/** Leitura mínima de projetos (sem acoplar ao PipelineService inteiro). */
export interface CampaignReader {
  listCampaignIds(): Promise<readonly string[]>;
  getCampaign(id: string): Promise<{ id: string; createdAt: string; request: { projectName?: string; product: { id: string; name: string; images: readonly { id: string }[] }; avatar?: { avatarId?: string } } }>;
}

export function revisionViews(record: { current: Avatar; revisions: readonly Avatar[] }): AvatarRevisionView[] {
  return [...record.revisions].sort((a, b) => b.revision - a.revision).map((r) => ({
    revision: r.revision, current: r.revision === record.current.revision, updatedAt: r.updatedAt,
    imageUrl: r.referenceImage ? imagePreviewUrl(r.referenceImage.ownerId, r.referenceImage.imageId) ?? null : null,
  }));
}

export async function avatarUsage(service: CampaignReader, avatarId: string, limit = 3): Promise<AvatarUsageView> {
  const used: AvatarUsageView["recent"] = [];
  for (const id of await service.listCampaignIds()) {
    try {
      const c = await service.getCampaign(id);
      if (c.request.avatar?.avatarId !== avatarId) continue;
      const image = c.request.product.images[0];
      used.push({ id: c.id, name: c.request.projectName || c.request.product.name, createdAt: c.createdAt, thumbnailUrl: image ? imagePreviewUrl(c.request.product.id, image.id) ?? null : null });
    } catch {
      // Projeto ilegível: não entra na contagem.
    }
  }
  used.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { count: used.length, recent: used.slice(0, limit) };
}

/** Perfil do avatar: atual + revisões + uso nos projetos (só leitura). */
export async function getAvatarDetail(deps: AvatarDeps & { service?: CampaignReader }, id: string): Promise<AvatarDetailView | undefined> {
  if (!deps.avatars || !SAFE_AVATAR_ID.test(id)) return undefined;
  let record: Awaited<ReturnType<AvatarLibraryStore["getAvatarRecord"]>>;
  try { record = await deps.avatars.getAvatarRecord(id); } catch { return undefined; }
  if (record.current.archived) return undefined;
  return { avatar: avatarView(record.current), revisions: revisionViews(record), usage: deps.service ? await avatarUsage(deps.service, id) : null };
}

function fieldErrorsOf(issues: readonly { path: PropertyKey[]; message: string }[]): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  for (const issue of issues) errors[issue.path.map(String).join(".") || "form"] ??= issue.message;
  return errors;
}

/**
 * Cria (sem `id` existente) ou atualiza um avatar. Mudança de identidade visual cria nova
 * revisão; nome/tags/voz só atualizam a revisão atual (registrada também no histórico).
 */
export async function saveAvatar(deps: AvatarDeps, input: { id?: string } & Record<string, unknown>): Promise<Result<AvatarView>> {
  try {
    const store = requireStore(deps);
    const parsed = AvatarInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: { code: "validation", title: "Revise o avatar", message: "Alguns campos precisam de ajuste.", retryable: false }, fieldErrors: fieldErrorsOf(parsed.error.issues) };
    const data = parsed.data;
    const id = typeof input.id === "string" && SAFE_AVATAR_ID.test(input.id) ? input.id : newAvatarId();
    let previous: Awaited<ReturnType<AvatarLibraryStore["getAvatarRecord"]>> | undefined;
    try { previous = await store.getAvatarRecord(id); } catch { previous = undefined; }

    let referenceImage: Avatar["referenceImage"];
    if (data.referenceImage) {
      // Caminho SEMPRE do UploadStore, nunca do browser.
      const [stored] = await deps.uploads.resolve(data.referenceImage.ownerId, [data.referenceImage.imageId]);
      if (!stored) return { ok: false, error: { code: "validation", title: "Revise a foto", message: "A foto de referência não foi encontrada. Envie de novo.", retryable: false }, fieldErrors: { referenceImage: "Foto não encontrada." } };
      referenceImage = { ownerId: data.referenceImage.ownerId, imageId: stored.id, uri: stored.uri };
    }
    const voices = await listVoiceProfiles(deps);
    const voice = data.voiceProfileId ? voices.find((v) => v.id === data.voiceProfileId && v.enabled) : undefined;
    if (data.voiceProfileId && !voice) return { ok: false, error: { code: "validation", title: "Revise a voz", message: "Escolha uma voz ativa da lista.", retryable: false }, fieldErrors: { voiceProfileId: "Voz indisponível." } };

    const at = now(deps);
    const base = previous?.current;
    const next = AvatarSchema.parse({
      id, revision: base?.revision ?? 1, name: data.name, active: data.active ?? base?.active ?? true,
      ...(referenceImage ? { referenceImage } : base?.referenceImage && !("referenceImage" in input) ? { referenceImage: base.referenceImage } : {}),
      gender: data.gender, appearanceDescriptors: data.appearanceDescriptors ?? "", visualAgeRange: data.visualAgeRange ?? "30s",
      hair: data.hair ?? "", appearancePrompt: data.appearancePrompt ?? "", defaultOutfit: data.defaultOutfit ?? "",
      defaultEnvironment: data.defaultEnvironment ?? "", ...(data.environment ? { environment: data.environment } : {}),
      speakingStyle: data.speakingStyle ?? "", personality: data.personality ?? "",
      tags: normalizeTags(data.tags ?? []), preferredProductCategories: normalizeTags(data.preferredProductCategories ?? []),
      defaultForTags: normalizeTags(data.defaultForTags ?? []),
      ...(voice ? { voiceProfileId: voice.id, voiceProvider: voice.provider, voiceName: voice.name, voiceSettings: { stability: voice.stability, speed: voice.speed, similarity: voice.similarity } } : {}),
      archived: false, createdAt: base?.createdAt ?? at, updatedAt: at,
    });
    const bumped = base && identityChanged(base, next) ? { ...next, revision: base.revision + 1 } : next;
    const revisions = previous
      ? bumped.revision !== base!.revision ? [...previous.revisions, bumped] : previous.revisions.map((r) => (r.revision === bumped.revision ? bumped : r))
      : [bumped];
    await store.saveAvatarRecord({ current: bumped, revisions });
    return { ok: true, value: avatarView(bumped) };
  } catch (error) {
    return { ok: false, error: toUserError(error) };
  }
}

export async function setAvatarActive(deps: AvatarDeps, id: string, active: boolean): Promise<Result<AvatarView>> {
  try {
    const store = requireStore(deps);
    const record = await store.getAvatarRecord(id);
    const current = { ...record.current, active, updatedAt: now(deps) };
    await store.saveAvatarRecord({ current, revisions: record.revisions.map((r) => (r.revision === current.revision ? current : r)) });
    return { ok: true, value: avatarView(current) };
  } catch (error) {
    return { ok: false, error: toUserError(error) };
  }
}

/** "Excluir" = arquivar: some da biblioteca, mas jobs antigos continuam com a revisão usada. */
export async function archiveAvatar(deps: AvatarDeps, id: string): Promise<Result<{ id: string }>> {
  try {
    const store = requireStore(deps);
    const record = await store.getAvatarRecord(id);
    const current = { ...record.current, active: false, archived: true, updatedAt: now(deps) };
    await store.saveAvatarRecord({ current, revisions: record.revisions.map((r) => (r.revision === current.revision ? current : r)) });
    return { ok: true, value: { id } };
  } catch (error) {
    return { ok: false, error: toUserError(error) };
  }
}
