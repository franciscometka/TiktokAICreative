import type { PreflightCheck } from "@/domain/readiness";
import { readKreaApiKey, type AppConfig } from "./env";
import { kreaUgcPricingRefs } from "./krea-ugc-models";
import { PRICING_TABLE } from "./pricing";

export interface KreaUgcReadiness {
  /** true só com TODAS as checagens ok. A chave sozinha nunca habilita REAL. */
  ready: boolean;
  reason?: string;
  checks: PreflightCheck[];
}

/**
 * Preflight local do AI UGC REAL via Krea (sem rede): chave presente, `UGC_PROVIDER=krea` e opt-in
 * explícito `UGC_REAL_ALLOWED=true` (o mesmo do Google). Nunca expõe o valor do segredo.
 */
export function kreaUgcReadiness(config: Pick<AppConfig, "ugc">, env: Record<string, string | undefined> = process.env): KreaUgcReadiness {
  const key = !!readKreaApiKey(env);
  const refs = (["economy", "high", "premium"] as const).flatMap(quality => Object.values(kreaUgcPricingRefs(quality)));
  const pricingReady = refs.every(ref => PRICING_TABLE.some(price => price.provider === ref.provider && price.model === ref.model
    && !price.isPlaceholder && price.priceUsd > 0 && price.currency === "USD" && !!price.updatedAt && !!price.source));
  const checks: PreflightCheck[] = [
    { id: "key", label: "Chave Krea API", ok: key, detail: key ? "KREA_API_KEY presente no servidor; o segredo não é exibido." : "KREA_API_KEY não configurada no servidor." },
    { id: "provider", label: "Provider AI UGC", ok: config.ugc.provider === "krea", detail: config.ugc.provider === "krea" ? "UGC_PROVIDER=krea." : `UGC_PROVIDER=${config.ugc.provider}. Use krea para o REAL via Krea.` },
    { id: "allowed", label: "REAL permitido", ok: config.ugc.realAllowed, detail: config.ugc.realAllowed ? "UGC_REAL_ALLOWED=true: REAL permitido, ainda com aprovação por job." : "UGC_REAL_ALLOWED=false (padrão): REAL bloqueado mesmo com chave." },
    { id: "model", label: "Modelos Krea", ok: pricingReady, detail: pricingReady ? "Nano Banana 2 e Veo 3.1 Fast reconhecidos." : "Modelo ou preço oficial Krea ausente/inválido." },
    { id: "pricing", label: "Pricing Krea", ok: pricingReady, detail: pricingReady ? "Tabela oficial com moeda, data e fonte configurada." : "Pricing Krea inválido; REAL bloqueado." },
  ];
  const failed = checks.find(check => !check.ok);
  return { ready: !failed, reason: failed ? `AI UGC REAL (Krea) indisponível: ${failed.detail}` : undefined, checks };
}
