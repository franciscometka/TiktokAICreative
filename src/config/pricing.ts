import type { ExchangeRate, ProviderPricing } from "@/domain/cost";
import { ANTHROPIC_PROVIDER, CLAUDE_MODELS } from "./llm-models";
import { ELEVENLABS_MODELS, ELEVENLABS_PROVIDER } from "./tts-models";

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

  // ---- Áudio / TTS: ElevenLabs (preço OFICIAL da API, cobrado em USD por caractere) ----
  // elevenlabs.io/pricing/api, verificado em 2026-10-14. Planos de assinatura usam créditos e
  // podem sair diferentes: este é o preço de API pay-as-you-go.
  {
    provider: ELEVENLABS_PROVIDER,
    model: ELEVENLABS_MODELS.flash,
    unit: "per_1000_characters",
    priceUsd: 0.04,
    updatedAt: "2026-10-14",
    isPlaceholder: false,
    source: "ElevenLabs API pricing — Flash/Turbo",
  },
  {
    provider: ELEVENLABS_PROVIDER,
    model: ELEVENLABS_MODELS.multilingual,
    unit: "per_1000_characters",
    priceUsd: 0.08,
    updatedAt: "2026-10-14",
    isPlaceholder: false,
    source: "ElevenLabs API pricing — Multilingual v2",
  },

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
