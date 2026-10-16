import type { z } from "zod";
import type { CampaignPlanDraft } from "@/domain/campaign";
import { UGC_PERSON_SOURCES } from "@/domain/ugc";
import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { UGC_PREFERRED_OPENERS, validateUgcScenes } from "../ugc-script";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_4_0 } from "./campaign-plan.v1_4_0";

/**
 * campaign-plan@1.5.0 = 1.4.0 + modo AI UGC (Lote 5.3). Fora do AI UGC, os tipos ugc_* e
 * product_broll são recusados (nada muda para o fluxo existente). No AI UGC: estrutura
 * hook → (demo/benefit/B-roll) → CTA com a MESMA pessoa segurando o produto real, fala de creator,
 * dentro da duração, sem experiência inventada. Sem validação paga ainda.
 */

const UGC_SYSTEM = `

# Modo AI UGC (somente quando o pedido indicar creativeMode=ai_ugc)
- Uma pessoa realista (fictícia) segura e apresenta o produto real em cenas ugc_hook, ugc_demo, ugc_benefit e ugc_cta; a MESMA pessoa, roupa, ambiente e produto em todas. product_broll é um close cinematográfico do produto. product_image e text_card podem complementar.
- A primeira cena é ugc_hook; deve existir uma ugc_cta. Cenas ugc_* e product_broll são geradas (requiresGeneratedVideo=true) e estimatedGenerationSeconds = duração da cena.
- Fala natural de creator do TikTok, em primeira pessoa só para APRESENTAR ("${UGC_PREFERRED_OPENERS.join('…", "')}…"). Proibido: "Conheça este incrível…", jargão publicitário, e qualquer experiência pessoal inventada ("uso há meses", "testei", "funcionou comigo", "comprei", depoimentos).
- Cada fala cabe na duração da cena: no máximo ${UGC_MAX_WORDS_PER_SECOND} palavras por segundo.
- visualDescription diz quem aparece, o que segura e o que faz. generationPrompt (inglês) descreve a ação e a câmera, citando "same person and exact product from the approved reference".
- Fora do modo AI UGC, nunca use ${[...UGC_PERSON_SOURCES, "product_broll"].join(", ")}.`;

export const campaignPlanPromptV1_5_0 = {
  ...campaignPlanPromptV1_4_0,
  version: "1.5.0",
  system: campaignPlanPromptV1_4_0.system + UGC_SYSTEM,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_4_0.buildUserMessage(input);
    if (input.creativeMode !== "ai_ugc") return `${base}\ncreativeMode=standard: não use cenas ugc_* nem product_broll.`;
    const audio = input.ugcAudioStrategy === "external_lipsync"
      ? "Estratégia de áudio: external_lipsync (narração ElevenLabs contínua + lip sync). Todas as cenas podem ter fala."
      : "Estratégia de áudio: native_speech (o vídeo gera a fala). Só cenas ugc_* têm narration; product_broll/product_image/text_card ficam com narration vazia.";
    return `${base}\ncreativeMode=ai_ugc. ${audio} Não use presenter nem product_ugc.`;
  },
  validationSchemaFor(input: CampaignPlanPromptInput) {
    return campaignPlanPromptV1_4_0.validationSchemaFor(input).superRefine((draft, ctx) => {
      draft.creatives.forEach((creative, i) => {
        if (input.creativeMode !== "ai_ugc") {
          creative.scenes.forEach((scene, j) => {
            if ((UGC_PERSON_SOURCES as readonly string[]).includes(scene.visualSource) || scene.visualSource === "product_broll") {
              ctx.addIssue({ code: "custom", path: ["creatives", i, "scenes", j, "visualSource"], message: "Cenas AI UGC só existem no modo ai_ugc." });
            }
          });
          return;
        }
        for (const issue of validateUgcScenes(creative.scenes, input.ugcAudioStrategy ?? "native_speech")) {
          ctx.addIssue({ code: "custom", path: issue.sceneIndex === null ? ["creatives", i, "scenes"] : ["creatives", i, "scenes", issue.sceneIndex], message: issue.message });
        }
      });
    }) as z.ZodType<CampaignPlanDraft>;
  },
};
