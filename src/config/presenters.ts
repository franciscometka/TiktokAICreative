export const RUNWAY_PRESENTER = { provider: "runway", model: "gwm1_avatars" } as const;
/** Offline Avatar Videos tariff: 1 credit per 3s. Round up conservatively per clip. */
export function presenterBilledSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) throw new Error("Presenter: trecho deve ter entre 0 e 30 segundos; revise a cena.");
  return Math.ceil((seconds - 1e-8) / 3) * 3;
}
