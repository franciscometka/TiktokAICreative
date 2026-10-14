/** Fonte de tempo injetável. Retorna ISO-8601. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): Clock {
  return () => iso;
}
