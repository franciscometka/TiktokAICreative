/** Primeiro modelo real: todos os presets usam Turbo; não promete tiers inexistentes. */
export const RUNWAY_VIDEO = { provider: "runway", model: "gen4_turbo" } as const;
export const DEFAULT_VIDEOS_DIR = "outputs/videos";
/** Durações conservadoras suportadas pelo Gen-4 Turbo. Nunca subestimar o clipe comprado. */
export function runwayDuration(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) throw new Error("Runway: cena deve ter entre 0 e 10 segundos de IA; revise o plano.");
  return seconds <= 5 ? 5 : 10;
}
