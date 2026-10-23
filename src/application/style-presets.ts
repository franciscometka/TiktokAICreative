import type { TargetDuration } from "@/config/duration-targets";

/**
 * L8.3/L8.4 — presets de estilo da Home e do Create. Só PREENCHEM campos que o Create V2 já
 * aceita (tom, CTA, duração). Não existe pipeline, estilo de render nem prompt novo por preset:
 * o estilo enviado continua "ugc_natural" e o resto é o mesmo `startVideoV2`.
 */

export type StylePresetId = "natural" | "presentation" | "offer" | "demo";

export interface StylePreset {
  id: StylePresetId;
  /** Nome no Create (passo Estilo). */
  label: string;
  /** Nome no chip da Home. */
  homeLabel: string;
  description: string;
  tone: string;
  cta: string;
  duration: TargetDuration;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  { id: "natural", label: "Natural UGC", homeLabel: "UGC de produto", description: "Recomendação espontânea, como de uma amiga.", tone: "Natural e espontâneo, como uma recomendação de amiga", cta: "Dá uma olhada no link", duration: 30 },
  { id: "presentation", label: "Apresentação", homeLabel: "Apresentação", description: "Apresenta o produto e seus benefícios com clareza.", tone: "Claro e confiante, apresentando os benefícios", cta: "Conheça no link", duration: 45 },
  { id: "offer", label: "Oferta rápida", homeLabel: "Oferta rápida", description: "Direto ao ponto, com senso de oportunidade.", tone: "Direto e animado, com senso de oportunidade", cta: "Aproveita a oferta no link", duration: 30 },
  { id: "demo", label: "Demonstração", homeLabel: "Demonstração", description: "Mostra o produto em uso, passo a passo.", tone: "Didático, mostrando o produto em uso passo a passo", cta: "Veja funcionando no link", duration: 60 },
];

export const DEFAULT_STYLE_PRESET: StylePresetId = "natural";

export function isStylePresetId(value: unknown): value is StylePresetId {
  return typeof value === "string" && STYLE_PRESETS.some((p) => p.id === value);
}

export function stylePreset(id: StylePresetId): StylePreset {
  return STYLE_PRESETS.find((p) => p.id === id)!;
}
