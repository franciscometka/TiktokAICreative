import { randomUUID } from "node:crypto";

/** Gera IDs com prefixo legível (ex.: "job_3f2a..."). Injetável para testes determinísticos. */
export type IdGenerator = (prefix: string) => string;

export const randomId: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}
