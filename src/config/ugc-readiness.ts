import type { PreflightCheck } from "@/domain/readiness";
import { readGoogleAiApiKey, type AppConfig } from "./env";
import { GEMINI_UGC_REFERENCE_MODEL, VEO_3_1_MODELS } from "./ugc-models";

export interface GoogleUgcReadiness {
  /** true só com TODAS as checagens ok. A chave sozinha nunca habilita REAL. */
  ready: boolean;
  reason?: string;
  checks: PreflightCheck[];
}

/**
 * Preflight local do AI UGC REAL (sem rede): chave presente, provider google selecionado, modelos
 * conhecidos e opt-in explícito `UGC_REAL_ALLOWED=true`. Nunca expõe o valor do segredo.
 */
export function googleUgcReadiness(config: Pick<AppConfig, "ugc">, env: Record<string, string | undefined> = process.env): GoogleUgcReadiness {
  const key = !!readGoogleAiApiKey(env);
  const knownVideo = (Object.values(VEO_3_1_MODELS) as string[]).includes(config.ugc.videoModel);
  const checks: PreflightCheck[] = [
    { id: "key", label: "Chave Gemini API", ok: key, detail: key ? "GOOGLE_AI_API_KEY presente no servidor; o segredo não é exibido." : "GOOGLE_AI_API_KEY não configurada no servidor." },
    { id: "provider", label: "Provider AI UGC", ok: config.ugc.provider === "google", detail: config.ugc.provider === "google" ? "UGC_PROVIDER=google." : "UGC_PROVIDER=mock (padrão). Use google para o REAL." },
    { id: "models", label: "Modelos", ok: config.ugc.referenceModel === GEMINI_UGC_REFERENCE_MODEL && knownVideo, detail: `Referência ${config.ugc.referenceModel} · vídeo ${config.ugc.videoModel}.` },
    { id: "allowed", label: "REAL permitido", ok: config.ugc.realAllowed, detail: config.ugc.realAllowed ? "UGC_REAL_ALLOWED=true: REAL permitido, ainda com aprovação por job." : "UGC_REAL_ALLOWED=false (padrão): REAL bloqueado mesmo com chave." },
  ];
  const failed = checks.find(check => !check.ok);
  return { ready: !failed, reason: failed ? `AI UGC REAL indisponível: ${failed.detail}` : undefined, checks };
}
