import { z } from "zod";
import type { CampaignPlanDraft } from "@/domain/campaign";
import { DURATION_TARGETS, isTargetDuration } from "@/config/duration-targets";
import { normalizeMasterScriptDraft } from "../master-script";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_8_0 } from "./campaign-plan.v1_8_0";

/**
 * campaign-plan@1.8.1 = 1.8.0 + correção do "Não conseguimos preparar o roteiro".
 *
 * Causa (reproduzida offline): com duração escolhida, cada trecho tem 6,6s e a validação herdada
 * (1.5.0) limita a fala a 18 palavras POR TRECHO. Um nome de produto longo ("Secador de Cabelos
 * Profissional Color Wind Santa Clara 2100W 220V" = 10 palavras) estoura um trecho, as duas
 * tentativas pagas falham do mesmo jeito e o plano é recusado — mesmo com o roteiro total dentro
 * do alvo. Como a divisão em trechos é do SISTEMA (roteiro mestre), a 1.8.1:
 *   1. re-divide o roteiro deterministicamente ANTES de validar e dá a cada trecho a duração em
 *      que a fala cabe (até 8s) — nenhum reparo por LLM para um ajuste determinístico;
 *   2. pede ao Claude um nome CURTO do produto na fala (as especificações continuam exatas).
 */

const SHORT_NAME = `

# Nome do produto na fala (1.8.1)
- Na fala, use um nome curto e natural do produto ("esse secador", "o Color Wind"), não o título completo do anúncio. Cite no máximo uma especificação por frase, exatamente como nos dados (ex.: 2100W), sem arredondar nem trocar números.`;

function hasTarget(input: CampaignPlanPromptInput): boolean {
  return input.creativeMode === "ai_ugc" && input.ugcPresenterOnly !== false && isTargetDuration(input.targetDurationSeconds);
}

export const campaignPlanPromptV1_8_1 = {
  ...campaignPlanPromptV1_8_0,
  version: "1.8.1",
  system: campaignPlanPromptV1_8_0.system + SHORT_NAME,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_8_0.buildUserMessage(input);
    if (!hasTarget(input)) return base;
    const target = DURATION_TARGETS[input.targetDurationSeconds!];
    return `${base}\nA divisão do roteiro em ${target.clips} trechos é refeita pelo sistema nas fronteiras de frase; escreva frases curtas (até ~18 palavras cada).`;
  },
  validationSchemaFor(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_8_0.validationSchemaFor(input);
    if (!hasTarget(input)) return base;
    return z.preprocess(normalizeMasterScriptDraft, base) as unknown as z.ZodType<CampaignPlanDraft>;
  },
};
