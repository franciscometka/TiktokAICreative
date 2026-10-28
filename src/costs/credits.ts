/**
 * L8.2 — créditos: unidade de consumo AMIGÁVEL sobre o custo real em BRL.
 *
 * Duas camadas, sem dupla contabilidade:
 *   financeiro (fonte da verdade): provider → custo real BRL → ledger (append-only);
 *   UX: BRL × CREDITS_PER_BRL → créditos. Nenhum débito de crédito é gravado em lugar nenhum.
 *
 * Arredondamento (política única, documentada):
 *   - ESTIMATIVA → `estimatedCreditsFromBrl`: para CIMA. Uma estimativa nunca promete consumir
 *     menos do que pode ocorrer (R$ 8,374 → 838).
 *   - REAL (ledger) → `actualCreditsFromBrl`: matemático (meio para cima). Soma-se o BRL em
 *     micro-reais inteiros ANTES de converter, para não acumular arredondamento por entrada.
 *   - Partes (categoria, dia, linha) → `apportion`: maior resto, a soma das partes é sempre o total.
 * Tudo em inteiros de micro-real: sem erro de ponto flutuante (8,37 × 100 = 837, nunca 836,999…).
 */

export interface CreditsConfig {
  /** Créditos por R$ 1,00 de custo real (CREDITS_PER_BRL). */
  perBrl: number;
  /** Franquia mensal em créditos (MONTHLY_CREDIT_ALLOWANCE). */
  monthlyAllowance: number;
  /** Fuso do corte mensal e dos dias do gráfico (CREDITS_TIMEZONE). */
  timeZone: string;
}

/** Saldo "baixo" quando o restante é ≤ 20% da franquia (âmbar; vermelho só no zero). */
export const CREDITS_LOW_RATIO = 0.2;

const MICRO = 1_000_000;

/** BRL → micro-reais inteiros (R$ 8,374 → 8_374_000). */
export function toMicroBrl(brl: number): number {
  return Math.round(brl * MICRO);
}

function creditsFromMicro(micro: number, perBrl: number, mode: "ceil" | "round"): number {
  // micro × perBrl é inteiro exato quando perBrl é inteiro; a divisão final é a única etapa em float.
  const raw = (micro * perBrl) / MICRO;
  const value = mode === "ceil" ? Math.ceil(raw - 1e-9) : Math.round(raw + 1e-9);
  return Math.max(0, value);
}

/** Estimativa (antes de gastar): para cima. */
export function estimatedCreditsFromBrl(brl: number, perBrl: number): number {
  return creditsFromMicro(toMicroBrl(brl), perBrl, "ceil");
}

/** Custo REAL (ledger): arredondamento matemático. */
export function actualCreditsFromBrl(brl: number, perBrl: number): number {
  return creditsFromMicro(toMicroBrl(brl), perBrl, "round");
}

/** Soma de custos reais (BRL) → créditos, somando em micro-reais antes de converter. */
export function actualCreditsFromBrlSum(values: readonly number[], perBrl: number): number {
  return creditsFromMicro(values.reduce((sum, v) => sum + toMicroBrl(v), 0), perBrl, "round");
}

/**
 * Reparte `total` créditos proporcionalmente aos pesos (maior resto). A soma das partes é
 * exatamente `total`; peso zero recebe zero. Empate de resto: ordem original (estável).
 */
export function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) / sum) * total);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, p) => a + p, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).filter((x) => weights[x.i]! > 0).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

export interface EstimateLike {
  totalBrl: number;
  lines?: readonly { label: string; brl: number }[];
}

export interface CreditEstimate {
  /** Total ESTIMADO (para cima). Exibir sempre com "~". */
  total: number;
  lines: { label: string; credits: number }[];
}

/** Estimate/quote existente → créditos estimados. Reutilizado pelo Create (L8.4); nada de conta em componente. */
export function creditsFromEstimate(estimate: EstimateLike, perBrl: number): CreditEstimate {
  const total = estimatedCreditsFromBrl(estimate.totalBrl, perBrl);
  const lines = estimate.lines ?? [];
  const parts = apportion(lines.map((l) => toMicroBrl(l.brl)), total);
  return { total, lines: lines.map((l, i) => ({ label: l.label, credits: parts[i]! })) };
}

export type CreditsState = "normal" | "low" | "empty";

export interface CreditsBalance {
  allowance: number;
  used: number;
  remaining: number;
  /** Uso acima da franquia (só informativo nesta versão). */
  overage: number;
  state: CreditsState;
}

export function creditsBalance(used: number, allowance: number): CreditsBalance {
  const remaining = Math.max(0, allowance - used);
  const overage = Math.max(0, used - allowance);
  const state: CreditsState = remaining <= 0 ? "empty" : remaining <= allowance * CREDITS_LOW_RATIO ? "low" : "normal";
  return { allowance, used, remaining, overage, state };
}

/** Saldo estimado após gastar `estimated` créditos (nunca apresentado como saldo real). */
export function remainingAfter(remaining: number, estimated: number): number {
  return Math.max(0, remaining - estimated);
}

// ---------------------------------------------------------------- período mensal no fuso configurado

function zonedParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second) };
}

/** Deslocamento (ms) do fuso no instante dado: horário local − UTC. */
function offsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instante UTC da meia-noite local de (y, m, d) no fuso (duas passadas cobrem horário de verão). */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - offsetMs(new Date(guess), timeZone);
  at = guess - offsetMs(new Date(at), timeZone);
  return new Date(at);
}

export interface CreditsPeriod {
  /** ISO do início (incluso) e do fim (exclusivo) do mês corrente no fuso. */
  start: string;
  end: string;
  timeZone: string;
}

export function monthPeriod(now: Date, timeZone: string): CreditsPeriod {
  const { y, m } = zonedParts(now, timeZone);
  const start = zonedMidnight(y, m, 1, timeZone);
  const end = m === 12 ? zonedMidnight(y + 1, 1, 1, timeZone) : zonedMidnight(y, m + 1, 1, timeZone);
  return { start: start.toISOString(), end: end.toISOString(), timeZone };
}

export function inPeriod(iso: string, period: CreditsPeriod): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(period.start) && t < Date.parse(period.end);
}

/** "2026-10-22" no fuso (chave do dia no gráfico). */
export function dayKey(at: Date | string, timeZone: string): string {
  const p = zonedParts(typeof at === "string" ? new Date(at) : at, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Dias do período até `now` (inclusive), em ordem. */
export function periodDays(period: CreditsPeriod, now: Date): string[] {
  const days: string[] = [];
  const last = dayKey(new Date(Math.min(now.getTime(), Date.parse(period.end) - 1)), period.timeZone);
  for (let t = Date.parse(period.start) + 12 * 3600_000; ; t += 24 * 3600_000) {
    const key = dayKey(new Date(t), period.timeZone);
    if (days.at(-1) !== key) days.push(key);
    if (key === last || days.length > 31) break;
  }
  return days;
}

/** "1.840" (pt-BR, sem casas). */
export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}
