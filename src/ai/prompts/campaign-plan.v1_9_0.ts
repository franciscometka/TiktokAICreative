import type { z } from "zod";
import type { CampaignPlanDraft } from "@/domain/campaign";
import { DURATION_TARGETS, isTargetDuration } from "@/config/duration-targets";
import { checkScriptV2 } from "../master-script";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_8_1 } from "./campaign-plan.v1_8_1";

/**
 * campaign-plan@1.9.0 = 1.8.1 + Script V2 (Lote 6.2). O roteiro de um vídeo real soou como ficha
 * técnica ("Esse aqui é o X." "Ele é vendido como…" "A potência dele é de 2100W." "Ele é 220V.").
 * Agora: FEATURE → CONTEXTO → AÇÃO VISUAL, estrutura por tempo, menos muletas, nada de linguagem de
 * catálogo e nenhum benefício técnico inventado. A validação bloqueia ficha técnica/repetição
 * (`checkScriptV2`); a re-divisão determinística da 1.8.1 continua valendo.
 */

const SCRIPT_V2 = `

# Script V2 (1.9.0) — fala de pessoa, não ficha técnica
- Cada característica entra como FEATURE → CONTEXTO → AÇÃO VISUAL, numa frase fluida: o que é, por que isso importa no uso (só com fatos fornecidos) e o que ela mostra com as mãos enquanto fala. Ex.: "Ele tem 2100 watts e vem com esse bico direcionador, então dá pra controlar melhor o ar enquanto seca" (enquanto mostra o bico).
- Nunca invente benefício técnico, número ou resultado que não esteja nos dados. Sem dado suficiente, descreva o que se VÊ no produto.
- Proibido linguagem de catálogo: "ele é vendido como", "este produto possui", "este equipamento oferece", "possui as seguintes".
- Nada de lista de frases curtas soltas ("Ele é 220V." "Ele tem X."). Junte especificações ao contexto.
- Varie: no máximo 2× cada uma de "esse modelo", "esse aqui", "olha só", "vou mostrar", "confere"; no máximo 3 frases começando com "Ele".
- Linguagem brasileira simples ("Esse é o…", "Ele tem…", "Repara aqui…", "Uma coisa importante…", "Vale conferir…"), sem exagero de gíria.
- Divida em frases que terminam pensamentos completos; o sistema corta os trechos em fim de pensamento/ação visual, nunca no meio.
- Final: CTA falado com naturalidade; depois da última palavra a pessoa continua ~1s em cena (sorriso, olhar para o produto, baixar um pouco o produto).`;

function hasTarget(input: CampaignPlanPromptInput): boolean {
  return input.creativeMode === "ai_ugc" && input.ugcPresenterOnly !== false && isTargetDuration(input.targetDurationSeconds);
}

/** Janelas da estrutura V2 escaladas para a duração escolhida (base: 30s → final ~35s). */
export function structureFor(seconds: number): string {
  const k = (seconds + 5) / 35;
  const t = (x: number) => Math.round(x * k);
  return `Estrutura aproximada: 0–${t(5)}s hook + produto; ${t(5)}–${t(13)}s principal característica; ${t(13)}–${t(21)}s segunda característica + demonstração; ${t(21)}–${t(29)}s informação importante/especificação; ${t(29)}–${t(35)}s+ fechamento + CTA. Roteiro contínuo, nunca mini-roteiros por trecho.`;
}

export const campaignPlanPromptV1_9_0 = {
  ...campaignPlanPromptV1_8_1,
  version: "1.9.0",
  system: campaignPlanPromptV1_8_1.system + SCRIPT_V2,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_8_1.buildUserMessage(input);
    if (!hasTarget(input)) return base;
    const target = DURATION_TARGETS[input.targetDurationSeconds!];
    return `${base}\n${structureFor(target.seconds)} Vídeo final entre ${target.finalVideoSeconds.min} e ${target.finalVideoSeconds.max}s: use conteúdo útil dentro dos fatos conhecidos, nunca frases vazias, e não acelere a fala.`;
  },
  validationSchemaFor(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_8_1.validationSchemaFor(input);
    if (!hasTarget(input)) return base;
    return base.superRefine((draft, ctx) => {
      draft.creatives.forEach((creative, i) => {
        for (const issue of checkScriptV2(creative.script)) ctx.addIssue({ code: "custom", path: ["creatives", i, "script"], message: issue });
      });
    }) as unknown as z.ZodType<CampaignPlanDraft>;
  },
};
