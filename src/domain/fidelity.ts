import { z } from "zod";

/**
 * Product Fidelity Gate (Lote 5.6). A referência gerada pode alterar o produto (ex.: "2100W" virou
 * "3900"). Ainda não temos OCR/visão confiável; por isso a arquitetura aceita três fontes:
 *   A) regras sobre dados ESTRUTURADOS do produto (constraints derivadas aqui);
 *   B) comparação visual/modelo no futuro (`observedTexts` vindos de um verificador);
 *   C) revisão humana (hoje, obrigatória).
 * Nunca há falsa garantia automática: sem revisão humana o status fica `pending`.
 */

const nonEmpty = z.string().trim().min(1);

export const FIDELITY_KINDS = ["number", "text", "logo", "color", "shape", "model", "buttons", "packaging"] as const;
export const FidelityConstraintSchema = z.object({
  kind: z.enum(FIDELITY_KINDS),
  /** Valor esperado (ex.: "2100W") ou descrição do que preservar. */
  expected: nonEmpty,
  source: z.enum(["product_name", "product_description", "product_features", "product_benefits", "default"]),
});
export type FidelityConstraint = z.infer<typeof FidelityConstraintSchema>;

export const FIDELITY_STATUSES = ["pending", "approved", "rejected", "needs_review"] as const;
export const FidelityStatusSchema = z.enum(FIDELITY_STATUSES);
export type FidelityStatus = z.infer<typeof FidelityStatusSchema>;

export const FidelityConflictSchema = z.object({ expected: nonEmpty, observed: nonEmpty, kind: z.enum(FIDELITY_KINDS) });
export type FidelityConflict = z.infer<typeof FidelityConflictSchema>;

export const ReferenceFidelitySchema = z.object({
  status: FidelityStatusSchema,
  constraints: z.array(FidelityConstraintSchema),
  conflicts: z.array(FidelityConflictSchema).default([]),
  /** Quem decidiu: regra automática (só pode REPROVAR/pedir revisão) ou humano. */
  checkedBy: z.enum(["rules", "human"]).optional(),
  /** Textos/números observados na imagem (revisão humana hoje; verificador visual no futuro). */
  observedTexts: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Especificações exatas (ex.: "2100W") conferidas UMA A UMA pelo humano. */
  confirmedSpecs: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  note: z.string().max(300).optional(),
  reviewedAt: z.string().optional(),
});
export type ReferenceFidelity = z.infer<typeof ReferenceFidelitySchema>;

/** Números com unidade/especificação: 2100W, 220V, 1,5 L, 500 ml, 3 velocidades, 24h, 2 em 1. */
const SPEC = /(\d+(?:[.,]\d+)?)\s?(w|kw|v|volts?|watts?|l|ml|litros?|mah|cm|mm|m|kg|g|h|horas?|min|°c|graus|rpm|velocidades?|temperaturas?|níveis|niveis|em\s?1|gb|tb|hz|polegadas|")(?![a-zà-ú])/gi;

const UNIT_ALIASES: Record<string, string> = {
  w: "W", watt: "W", watts: "W", kw: "kW", v: "V", volt: "V", volts: "V", l: "L", litro: "L", litros: "L", ml: "ml", mah: "mAh",
  cm: "cm", mm: "mm", m: "m", kg: "kg", g: "g", h: "h", gb: "GB", tb: "TB", hz: "Hz", rpm: "rpm", "°c": "°C", '"': '"',
};

function normalizeSpec(value: string, unit: string): string {
  const short = UNIT_ALIASES[unit.toLowerCase().replace(/\s+/g, "")];
  return short ? `${value}${short}` : `${value} ${unit.toLowerCase().replace(/\s+/g, " ")}`;
}

/** Constraints derivadas SÓ de dados fornecidos (nada inventado). */
export function deriveFidelityConstraints(product: { name: string; description: string; features: readonly string[]; benefits: readonly string[] }): FidelityConstraint[] {
  const out: FidelityConstraint[] = [];
  const seen = new Set<string>();
  const sources: [FidelityConstraint["source"], string][] = [
    ["product_name", product.name], ["product_description", product.description],
    ...product.features.map(f => ["product_features", f] as [FidelityConstraint["source"], string]),
    ...product.benefits.map(b => ["product_benefits", b] as [FidelityConstraint["source"], string]),
  ];
  for (const [source, text] of sources) {
    for (const match of text.matchAll(SPEC)) {
      const expected = normalizeSpec(match[1]!, match[2]!);
      const key = expected.toLowerCase().replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "number", expected, source });
    }
  }
  // Modelo/código: tokens com letras+dígitos no nome (ex.: "SC-2100", "X5"), quando não são specs já capturadas.
  for (const token of product.name.match(/\b[A-Z]{1,5}[- ]?\d{1,5}[A-Z]?\b/g) ?? []) {
    if (!seen.has(token.toLowerCase().replace(/\s+/g, ""))) { seen.add(token.toLowerCase()); out.push({ kind: "model", expected: token, source: "product_name" }); }
  }
  out.push(
    { kind: "text", expected: product.name, source: "product_name" },
    { kind: "logo", expected: "logo e marca exatamente como na foto original", source: "default" },
    { kind: "color", expected: "cores originais do produto", source: "default" },
    { kind: "shape", expected: "formato e proporções originais", source: "default" },
    { kind: "buttons", expected: "botões, bicos, cabos e detalhes físicos da foto original", source: "default" },
    { kind: "packaging", expected: "embalagem/rótulo quando aparecerem", source: "default" },
  );
  return out;
}

const digits = (text: string) => text.replace(/[^\d.,]/g, "").replace(",", ".");

/**
 * Regra automática (A/B): compara números esperados com textos OBSERVADOS. Só pode reprovar ou pedir
 * revisão — nunca aprova sozinha. Ex.: esperado "2100W", observado "3900" → conflito.
 */
export function findFidelityConflicts(constraints: readonly FidelityConstraint[], observedTexts: readonly string[]): FidelityConflict[] {
  const expectedNumbers = constraints.filter(c => c.kind === "number" || c.kind === "model");
  if (expectedNumbers.length === 0) return [];
  const conflicts: FidelityConflict[] = [];
  for (const observed of observedTexts) {
    const value = digits(observed);
    if (!value) continue;
    const matches = expectedNumbers.some(c => digits(c.expected) === value || c.expected.toLowerCase().replace(/\s+/g, "") === observed.toLowerCase().replace(/\s+/g, ""));
    if (!matches) {
      const nearest = expectedNumbers[0]!;
      conflicts.push({ expected: nearest.expected, observed, kind: nearest.kind });
    }
  }
  return conflicts;
}

/** Estado inicial da fidelidade de uma referência nova: sempre `pending` (revisão humana obrigatória). */
export function initialFidelity(constraints: readonly FidelityConstraint[]): ReferenceFidelity {
  return { status: "pending", constraints: [...constraints], conflicts: [], observedTexts: [], confirmedSpecs: [] };
}

/**
 * Decisão humana. `confirmed=true` sem conflitos → approved. Qualquer conflito conhecido (texto
 * observado divergente) impede aprovação automática: needs_review (ou rejected se o humano reprovar).
 */
export function decideFidelity(current: ReferenceFidelity, input: { confirmed: boolean; observedTexts?: readonly string[]; confirmedSpecs?: readonly string[]; note?: string; reviewedAt: string }): ReferenceFidelity {
  const observedTexts = (input.observedTexts ?? []).map(t => t.trim()).filter(Boolean).slice(0, 20);
  const conflicts = findFidelityConflicts(current.constraints, observedTexts);
  const confirmedSpecs = (input.confirmedSpecs ?? []).map(t => t.trim()).filter(Boolean).slice(0, 20);
  // Especificação conhecida (ex.: 2100W) sem conferência explícita: continua pendente, nunca aprova.
  const missing = missingSpecConfirmations(current.constraints, confirmedSpecs);
  const status: FidelityStatus = !input.confirmed ? "rejected" : conflicts.length > 0 ? "needs_review" : missing.length > 0 ? "pending" : "approved";
  return { ...current, status, conflicts, observedTexts, confirmedSpecs, checkedBy: conflicts.length > 0 && input.confirmed ? "rules" : "human", ...(input.note ? { note: input.note.slice(0, 300) } : {}), reviewedAt: input.reviewedAt };
}

/** Linhas para o prompt: o que NÃO pode mudar (textos, números, logo). */
export function fidelityPromptLines(constraints: readonly FidelityConstraint[]): string[] {
  const exact = exactSpecs(constraints).map(c => `"${c}"`);
  return [
    "Every text, number and marking already printed on the product must stay exactly as in the original product photo; copy them, never rewrite them.",
    exact.length
      ? `Known specifications from the product data: ${exact.join(", ")}. If a printed specification is visible it must read exactly that; never change the power, voltage, capacity or model values and never print a different number.`
      : "Never invent or add numbers or specifications.",
    "Never invent, add or change numbers, wattage, voltage, model codes or words. If a marking is unreadable, keep it as it is in the photo instead of inventing one.",
    "Keep the brand logo, printed text, model name, colors, shape, buttons, nozzle, cable and packaging exactly as in the original product photo.",
  ];
}

/** Especificações EXATAS conhecidas (números com unidade e modelo): cada uma exige conferência humana. */
export function exactSpecs(constraints: readonly FidelityConstraint[]): string[] {
  return constraints.filter(c => c.kind === "number" || c.kind === "model").map(c => c.expected);
}

const specKey = (value: string) => value.toLowerCase().replace(/\s+/g, "");

/** Especificações conhecidas que o humano ainda NÃO confirmou individualmente. */
export function missingSpecConfirmations(constraints: readonly FidelityConstraint[], confirmedSpecs: readonly string[] = []): string[] {
  const confirmed = new Set(confirmedSpecs.map(specKey));
  return exactSpecs(constraints).filter(spec => !confirmed.has(specKey(spec)));
}
