import type { ProjectCard } from "./project-v2-view";
import { isStylePresetId, type StylePresetId } from "./style-presets";

/**
 * L8.3 — Home Cinematic: regras puras (saudação, nome confiável, link para o Create, mini
 * dashboard e projetos recentes). Nada aqui inventa dado: o que não existe é omitido.
 */

/** A Home mostra exatamente os 4 projetos mais recentes (funciona em desktop e mobile). */
export const HOME_RECENT_LIMIT = 4;

export type DayPeriod = "morning" | "afternoon" | "evening";

/** Período pela hora LOCAL do navegador (o servidor nunca adivinha o fuso do usuário). */
export function dayPeriod(hour: number): DayPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

const PERIOD_LABEL: Record<DayPeriod, string> = { morning: "Bom dia", afternoon: "Boa tarde", evening: "Boa noite" };

/**
 * Sem nome confiável (ou modo local): "Olá." — sempre. Com nome: "Boa tarde, Ana"; antes de o
 * navegador informar a hora (render do servidor/hidratação): "Olá, Ana".
 */
export function greeting(period: DayPeriod | null, name: string | null): string {
  if (!name) return "Olá.";
  return `${period ? PERIOD_LABEL[period] : "Olá"}, ${name}`;
}

const NAME_KEYS = ["full_name", "name", "display_name"] as const;

/**
 * Nome real do usuário Supabase (`user_metadata`), só quando confiável. NUNCA deriva nome do
 * e-mail: qualquer valor com "@", só dígitos ou longo demais é descartado. Primeiro nome apenas.
 */
export function trustedDisplayName(claims: unknown): string | null {
  if (!claims || typeof claims !== "object") return null;
  const meta = (claims as { user_metadata?: unknown }).user_metadata;
  if (!meta || typeof meta !== "object") return null;
  for (const key of NAME_KEYS) {
    const raw = (meta as Record<string, unknown>)[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim().replace(/\s+/g, " ");
    if (!value || value.length > 60 || value.includes("@") || !/\p{L}/u.test(value)) continue;
    const first = value.split(" ")[0]!;
    if (first.length >= 2 && /^[\p{L}'-]+$/u.test(first)) return first;
  }
  return null;
}

/** Composer da Home → /create com foto, ideia e preset pré-preenchidos (o Create revalida tudo). */
export function createHref(draft: { productId?: string; imageId?: string; idea?: string; preset?: StylePresetId }): string {
  const params = new URLSearchParams();
  if (draft.productId && draft.imageId) { params.set("product", draft.productId); params.set("image", draft.imageId); }
  const idea = draft.idea?.trim();
  if (idea) params.set("idea", idea.slice(0, 2000));
  if (draft.preset && isStylePresetId(draft.preset)) params.set("preset", draft.preset);
  const query = params.toString();
  return query ? `/create?${query}` : "/create";
}

export interface HomeStat { id: "videos" | "credits" | "avatars"; label: string; value: number }

/** Mini dashboard: só números reais. Créditos não configurados → sem vídeos nem créditos. */
export function homeStats(input: { credits: { videosGenerated: number; remaining: number } | null; activeAvatars: number | null }): HomeStat[] {
  const stats: HomeStat[] = [];
  if (input.credits) {
    stats.push({ id: "videos", label: "Vídeos este mês", value: input.credits.videosGenerated });
    stats.push({ id: "credits", label: "Créditos disponíveis", value: input.credits.remaining });
  }
  if (input.activeAvatars !== null) stats.push({ id: "avatars", label: input.activeAvatars === 1 ? "Avatar ativo" : "Avatares ativos", value: input.activeAvatars });
  return stats;
}

export function recentProjects(cards: readonly ProjectCard[]): ProjectCard[] {
  return [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, HOME_RECENT_LIMIT);
}
