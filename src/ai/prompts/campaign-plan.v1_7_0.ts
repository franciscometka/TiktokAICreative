import { PRESENTER_POLICY } from "@/config/edit-policy";
import { isUgcPersonSource } from "@/domain/ugc";
import { validatePresenterScript } from "../ugc-script";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_6_1 } from "./campaign-plan.v1_6_1";

/**
 * campaign-plan@1.7.0 = 1.6.1 + Presenter Only (Lote 5.7). No AI UGC padrão, o vídeo INTEIRO é a
 * apresentadora falando com o produto: só cenas ugc_*, nenhum B-roll/foto/card. Roteiro de TikTok
 * brasileiro real (não comercial), 75–95 palavras para 32–40s, CTA dentro da fala no fim.
 * As instruções de B-roll da 1.6.x continuam valendo SÓ quando ugcPresenterOnly=false.
 * Sem validação paga ainda.
 */

const PRESENTER_ONLY = `

# Presenter Only (AI UGC padrão — substitui as regras de B-roll acima quando ativo)
- O vídeo INTEIRO mostra a MESMA apresentadora falando para a câmera e segurando/apresentando o produto. Use SOMENTE cenas ugc_hook, ugc_demo, ugc_benefit e ugc_cta. Proibido: reference_detail, product_broll, product_image, text_card, foto, zoom em foto ou card de produto.
- Planeje 5 a 6 trechos de 6 a 8s cada (o vídeo final fica entre ${PRESENTER_POLICY.targetFinalSeconds.min} e ${PRESENTER_POLICY.targetFinalSeconds.max}s; nunca menos de ${PRESENTER_POLICY.minFinalSeconds}s). Em cada trecho a apresentadora faz uma ação natural: segura, aproxima da câmera, olha para o produto, gira, aponta um detalhe, muda levemente de posição.
- Roteiro total de ${PRESENTER_POLICY.words.min} a ${PRESENTER_POLICY.words.max} palavras, em português brasileiro conversacional, frases curtas, como um TikTok de verdade. Estrutura: (A) hook natural → (B) apresentação rápida do produto → (C) 2 ou 3 detalhes/características REAIS fornecidos → (D) a apresentadora demonstra visualmente → (E) fechamento → (F) CTA natural.
- Exemplo de TOM (não copie literalmente): "Se você está procurando um secador de 2100 watts pro dia a dia, olha esse modelo aqui..." e continue naturalmente.
- Proibido: "produto revolucionário", "você precisa disso", exagero, linguagem de comercial de TV, depoimento falso, "eu uso há meses", "testei e...", benefícios não fornecidos. Priorize os fatos reais do produto.
- CTA dentro da fala do ÚLTIMO trecho (ugc_cta), nos últimos 4–6s, adaptado ao produto. Ex. de estilo: "Se você curtiu esse modelo, dá uma olhada no carrinho e confere os detalhes." ou "Se fizer sentido pra você, o produto está no carrinho pra você conferir." Proibido: "CORRA", falsa urgência, "últimas unidades", frase agressiva.
- A fala de cada trecho termina numa frase completa (o corte acontece na pausa). Deixe o último trecho terminar com a apresentadora em cena, sem falar, por cerca de 1 segundo.
- onScreenText vazio em todos os trechos (na tela só a legenda); no último pode ter um CTA curto opcional.`;

export const campaignPlanPromptV1_7_0 = {
  ...campaignPlanPromptV1_6_1,
  version: "1.7.0",
  system: campaignPlanPromptV1_6_1.system + PRESENTER_ONLY,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_6_1.buildUserMessage(input);
    if (input.creativeMode !== "ai_ugc") return base;
    return input.ugcPresenterOnly === false ? base
      : `${base}\nPresenter Only ATIVO: 5–6 trechos ugc_* da apresentadora, ${PRESENTER_POLICY.words.min}–${PRESENTER_POLICY.words.max} palavras no total, nenhum B-roll/foto/card.`;
  },
  validationSchemaFor(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_6_1.validationSchemaFor(input);
    if (input.creativeMode !== "ai_ugc" || input.ugcPresenterOnly === false) return base;
    return base.superRefine((draft, ctx) => {
      draft.creatives.forEach((creative, i) => {
        creative.scenes.forEach((scene, j) => {
          if (!isUgcPersonSource(scene.visualSource)) ctx.addIssue({ code: "custom", path: ["creatives", i, "scenes", j, "visualSource"], message: "Presenter Only: use só cenas ugc_* da apresentadora (sem B-roll, foto ou card)." });
        });
        for (const issue of validatePresenterScript(creative.scenes)) ctx.addIssue({ code: "custom", path: ["creatives", i, "scenes"], message: issue });
      });
    });
  },
};
