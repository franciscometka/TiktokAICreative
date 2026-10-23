import type { AvatarView } from "./avatar-actions";

/**
 * L8.7 — regras puras da biblioteca de avatares (busca, filtros, rótulos). Só dados que o domínio
 * já tem: tags livres, `defaultForTags`, voz, ativo/inativo. Nada de status ou taxonomia nova.
 */

export type AvatarFilter = "all" | "active" | "inactive" | { tag: string };

/** "cabelo" · "cabelo e beleza" · "cabelo, beleza e unhas" (sem o array cru). */
export function listLabel(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

/** "Padrão para cabelo e beleza" — null quando o avatar não é padrão para nada. */
export function defaultForLabel(tags: readonly string[]): string | null {
  return tags.length ? `Padrão para ${listLabel(tags.slice(0, 3))}${tags.length > 3 ? ` +${tags.length - 3}` : ""}` : null;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "•";
}

/** "Usar em novo vídeo": o Create (L8.4) revalida o avatar (só ativos entram). */
export function avatarCreateHref(id: string): string {
  return `/create?avatar=${encodeURIComponent(id)}`;
}

/** Tags mais usadas na biblioteca (para os chips de filtro). */
export function topTags(avatars: readonly AvatarView[], limit = 6): string[] {
  const count = new Map<string, number>();
  for (const a of avatars) for (const t of new Set([...a.tags, ...a.defaultForTags])) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([t]) => t);
}

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Busca por nome, tags e voz + filtro (ativos/inativos/tag). Ativos primeiro, depois nome. */
export function queryAvatars(avatars: readonly AvatarView[], q: { search?: string; filter?: AvatarFilter }): AvatarView[] {
  const term = strip(q.search?.trim() ?? "");
  const filter = q.filter ?? "all";
  return avatars
    .filter((a) => filter === "all" || (filter === "active" ? a.active : filter === "inactive" ? !a.active : [...a.tags, ...a.defaultForTags, ...a.preferredProductCategories].includes(filter.tag)))
    .filter((a) => !term || [a.name, a.voiceName ?? "", ...a.tags, ...a.defaultForTags, ...a.preferredProductCategories].some((v) => strip(v).includes(term)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "pt-BR"));
}

/** Busca/filtros só aparecem com avatares suficientes para justificar. */
export const AVATAR_SEARCH_THRESHOLD = 4;

export const AGE_LABELS: Record<AvatarView["visualAgeRange"], string> = { "20s": "20–29 anos", "30s": "30–39 anos", "40s": "40–49 anos" };

/** Estado do formulário do Avatar Studio: OS MESMOS campos do formulário do Lote 6. */
export interface AvatarFormState {
  name: string;
  gender: "woman" | "man";
  visualAgeRange: AvatarView["visualAgeRange"];
  personality: string;
  imageId: string | null;
  hair: string;
  defaultOutfit: string;
  appearanceDescriptors: string;
  appearancePrompt: string;
  defaultEnvironment: string;
  environment: string;
  voiceProfileId: string;
  speakingStyle: string;
  tags: string[];
  defaultForTags: string[];
  preferredProductCategories: string[];
}

export function avatarFormState(initial?: AvatarView): AvatarFormState {
  return {
    name: initial?.name ?? "", gender: initial?.gender ?? "woman", visualAgeRange: initial?.visualAgeRange ?? "30s", personality: initial?.personality ?? "",
    imageId: initial?.referenceImage?.imageId ?? null, hair: initial?.hair ?? "", defaultOutfit: initial?.defaultOutfit ?? "",
    appearanceDescriptors: initial?.appearanceDescriptors ?? "", appearancePrompt: initial?.appearancePrompt ?? "", defaultEnvironment: initial?.defaultEnvironment ?? "",
    environment: initial?.environment ?? "", voiceProfileId: initial?.voiceProfileId ?? "", speakingStyle: initial?.speakingStyle ?? "",
    tags: initial?.tags ?? [], defaultForTags: initial?.defaultForTags ?? [], preferredProductCategories: initial?.preferredProductCategories ?? [],
  };
}

/**
 * Payload IDÊNTICO ao do formulário anterior para `saveAvatarAction` (mesma regra de revisão no
 * servidor: mudar foto/aparência/roupa/ambiente cria revisão nova; nome/tags/voz atualizam a atual).
 */
export function avatarPayload(avatarId: string, s: AvatarFormState): Record<string, unknown> {
  return {
    id: avatarId, name: s.name, gender: s.gender, tags: s.tags, defaultForTags: s.defaultForTags, personality: s.personality,
    defaultEnvironment: s.defaultEnvironment, hair: s.hair, visualAgeRange: s.visualAgeRange, defaultOutfit: s.defaultOutfit,
    appearanceDescriptors: s.appearanceDescriptors, appearancePrompt: s.appearancePrompt, speakingStyle: s.speakingStyle,
    preferredProductCategories: s.preferredProductCategories,
    ...(s.environment ? { environment: s.environment } : {}), ...(s.voiceProfileId ? { voiceProfileId: s.voiceProfileId } : {}),
    ...(s.imageId ? { referenceImage: { ownerId: avatarId, imageId: s.imageId } } : {}),
  };
}
