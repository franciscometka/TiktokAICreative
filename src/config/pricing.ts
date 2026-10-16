import type { ExchangeRate, ProviderPricing } from "@/domain/cost";
import { ANTHROPIC_PROVIDER, CLAUDE_MODELS } from "./llm-models";
import { ELEVENLABS_MODELS, ELEVENLABS_PROVIDER } from "./tts-models";

import { RUNWAY_PRESENTER } from "./presenters";
import { RUNWAY_VIDEO } from "./video-models";
import { GEMINI_UGC_REFERENCE_MODEL, GOOGLE_UGC_PROVIDER, VEO_3_1_MODELS } from "./ugc-models";
import { KREA_UGC_PROVIDER, KREA_UGC_REFERENCE_MODEL, KREA_VEO_MODELS } from "./krea-ugc-models";

export const RUNWAY_CREDITS_PER_SECOND = 5;
export const RUNWAY_CREDIT_USD = 0.01;

const CLAUDE_PRICES_DATE = "2026-10-06";

/**
 * Entradas de preço de um modelo Claude. Escrita de cache = 1,25× o preço de entrada
 * (TTL de 5 minutos, regra oficial); leitura de cache conforme a tabela oficial do modelo.
 */
function claudePricing(
  model: string,
  prices: { input: number; output: number; cacheRead: number },
): ProviderPricing[] {
  const base = { provider: ANTHROPIC_PROVIDER, model, updatedAt: CLAUDE_PRICES_DATE, isPlaceholder: false };
  return [
    { ...base, unit: "per_1m_input_tokens", priceUsd: prices.input, source: "Anthropic API pricing" },
    { ...base, unit: "per_1m_output_tokens", priceUsd: prices.output, source: "Anthropic API pricing" },
    {
      ...base,
      unit: "per_1m_cache_write_tokens",
      priceUsd: prices.input * 1.25,
      source: "Anthropic: escrita de cache 5 min = 1,25× entrada",
    },
    { ...base, unit: "per_1m_cache_read_tokens", priceUsd: prices.cacheRead, source: "Anthropic API pricing" },
  ];
}

/**
 * ÚNICO lugar onde preços de providers são definidos (V1: arquivo local).
 * Futuro: carregar de banco/API via outra implementação de PricingCatalog (costs/pricing-catalog.ts).
 *
 * isPlaceholder = true → valor PROVISÓRIO, escolhido para caber nas metas iniciais dos presets.
 * Vídeo: nenhum provider real escolhido ainda ("unassigned-video" deixa isso explícito). Áudio: ElevenLabs
 * com preço oficial (Lote 4). Antes de integrar um provider real, use o preço oficial e isPlaceholder = false.
 */
export const PRICING_TABLE: readonly ProviderPricing[] = [
  { ...RUNWAY_VIDEO, unit: "per_second", priceUsd: RUNWAY_CREDITS_PER_SECOND * RUNWAY_CREDIT_USD,
    updatedAt: "2026-10-14", isPlaceholder: false, source: "https://docs.dev.runwayml.com/guides/pricing/" },
  { ...RUNWAY_PRESENTER, unit: "per_second", priceUsd: RUNWAY_CREDIT_USD / 3,
    updatedAt: "2026-10-15", isPlaceholder: false, source: "https://dev.runwayml.com/endpoints/avatar_videos" },
  // ---- LLM (preços oficiais Anthropic, tabela de 2026-10-06) ----
  ...claudePricing(CLAUDE_MODELS.opus, { input: 4, output: 20, cacheRead: 0.2 }),
  ...claudePricing(CLAUDE_MODELS.sonnet, { input: 2, output: 10, cacheRead: 0.2 }),
  // Haiku 5.5: preço válido para prompts até 100K tokens (acima: US$0.50/US$2.50).
  ...claudePricing(CLAUDE_MODELS.haiku, { input: 0.1, output: 0.5, cacheRead: 0.01 }),

  // ---- Vídeo (PROVISÓRIO: provider ainda não escolhido) ----
  {
    provider: "unassigned-video",
    model: "economy-tier",
    unit: "per_second",
    priceUsd: 0.08,
    updatedAt: "2026-10-13",
    isPlaceholder: true,
  },
  {
    provider: "unassigned-video",
    model: "high-tier",
    unit: "per_second",
    priceUsd: 0.12,
    updatedAt: "2026-10-13",
    isPlaceholder: true,
  },
  {
    provider: "unassigned-video",
    model: "premium-tier",
    unit: "per_second",
    priceUsd: 0.28,
    updatedAt: "2026-10-13",
    isPlaceholder: true,
  },

  // ---- Áudio / TTS: ElevenLabs (preço da API em USD por 1.000 caracteres ENVIADOS) ----
  // Tabela vigente da API (elevenlabs.io/pricing/api), confirmada em 2026-10-14 na validação real.
  // Créditos/quota da assinatura (e o header `character-cost`) são OUTRA unidade: não entram aqui.
  {
    provider: ELEVENLABS_PROVIDER,
    model: ELEVENLABS_MODELS.flash,
    unit: "per_1000_characters",
    priceUsd: 0.05,
    updatedAt: "2026-10-14",
    isPlaceholder: false,
    source: "elevenlabs.io/pricing/api — Flash/Turbo (tabela vigente, 2026-10-14)",
  },
  {
    provider: ELEVENLABS_PROVIDER,
    model: ELEVENLABS_MODELS.multilingual,
    unit: "per_1000_characters",
    priceUsd: 0.1,
    updatedAt: "2026-10-14",
    isPlaceholder: false,
    source: "elevenlabs.io/pricing/api — Multilingual v2 (tabela vigente, 2026-10-14)",
  },

  // ---- AI UGC Google (fonte oficial consultada em 2026-10-16; transportes REAL desligados) ----
  // Referência 1K: preço equivalente do OUTPUT. O transporte futuro deverá registrar também o
  // usage real de entrada/texto; a cotação atual reserva explicitamente a imagem produzida.
  { provider: GOOGLE_UGC_PROVIDER, model: GEMINI_UGC_REFERENCE_MODEL, unit: "per_generation", priceUsd: 0.067, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Gemini 3.1 Flash Image, saída 1K" },
  { provider: GOOGLE_UGC_PROVIDER, model: VEO_3_1_MODELS.lite, unit: "per_second", priceUsd: 0.05, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Lite 720p" },
  { provider: GOOGLE_UGC_PROVIDER, model: `${VEO_3_1_MODELS.lite}:1080p`, unit: "per_second", priceUsd: 0.08, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Lite 1080p" },
  { provider: GOOGLE_UGC_PROVIDER, model: VEO_3_1_MODELS.fast, unit: "per_second", priceUsd: 0.10, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Fast 720p" },
  { provider: GOOGLE_UGC_PROVIDER, model: `${VEO_3_1_MODELS.fast}:1080p`, unit: "per_second", priceUsd: 0.12, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Fast 1080p" },
  { provider: GOOGLE_UGC_PROVIDER, model: VEO_3_1_MODELS.standard, unit: "per_second", priceUsd: 0.40, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Standard 720p/1080p" },
  { provider: GOOGLE_UGC_PROVIDER, model: `${VEO_3_1_MODELS.standard}:1080p`, unit: "per_second", priceUsd: 0.40, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://ai.google.dev/gemini-api/docs/pricing — Veo 3.1 Standard 720p/1080p" },

  // ---- AI UGC via Krea (UGC_PROVIDER=krea). Fonte: https://api.krea.ai/openapi.json (x-krea-pricing), 2026-10-16.
  // Preço FIXO por requisição; Veo com áudio = linear em 4/6/8s → expresso por segundo.
  { provider: KREA_UGC_PROVIDER, model: KREA_UGC_REFERENCE_MODEL, unit: "per_generation", priceUsd: 0.08, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://api.krea.ai/openapi.json — Nano Banana 2, 1K: US$0,08 por requisição" },
  { provider: KREA_UGC_PROVIDER, model: KREA_VEO_MODELS.fast, unit: "per_second", priceUsd: 0.10, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://api.krea.ai/openapi.json — Veo 3.1 Fast 720p com áudio: US$0,40/0,60/0,80 (4/6/8s)" },
  { provider: KREA_UGC_PROVIDER, model: `${KREA_VEO_MODELS.fast}:1080p`, unit: "per_second", priceUsd: 0.12, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://api.krea.ai/openapi.json — Veo 3.1 Fast 1080p com áudio: US$0,48/0,72/0,96 (4/6/8s)" },
  { provider: KREA_UGC_PROVIDER, model: KREA_VEO_MODELS.standard, unit: "per_second", priceUsd: 0.40, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://api.krea.ai/openapi.json — Veo 3.1 720p com áudio: US$1,60/2,40/3,20 (4/6/8s)" },
  { provider: KREA_UGC_PROVIDER, model: `${KREA_VEO_MODELS.standard}:1080p`, unit: "per_second", priceUsd: 0.40, updatedAt: "2026-10-16", isPlaceholder: false, source: "https://api.krea.ai/openapi.json — Veo 3.1 1080p com áudio: US$1,60/2,40/3,20 (4/6/8s)" },

  // ---- Renderização local (Remotion na máquina do usuário) ----
  {
    provider: "local",
    model: "remotion",
    unit: "per_generation",
    priceUsd: 0,
    updatedAt: "2026-10-13",
    isPlaceholder: false,
    source: "Renderização local não tem custo de API",
  },
];

/** Cotação default se USD_BRL_EXCHANGE_RATE não estiver definida. Provisória. */
export const DEFAULT_EXCHANGE_RATE: ExchangeRate = {
  base: "USD",
  quote: "BRL",
  rate: 5.5,
  source: "default",
  updatedAt: "2026-10-13",
};
