import { EDIT_POLICY } from "@/config/edit-policy";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_5_0 } from "./campaign-plan.v1_5_0";

/**
 * campaign-plan@1.6.0 = 1.5.0 + Creative Editor V2 (Lote 5.6). O AI UGC é planejado como UMA
 * narrativa contínua: A-roll (pessoa falando, fala nativa) é a espinha; B-roll é detalhe
 * contextual por cima do áudio, recortado do frame de referência (`reference_detail`). O sistema
 * converte deterministicamente em plano editorial (ai/ugc-editorial.ts); o schema JSON não muda.
 * Sem validação paga ainda.
 */

const EDITOR_V2 = `

# Creative Editor V2 (AI UGC)
- Pense em UM vídeo contínuo de creator, não em cenas independentes coladas. Cada corte precisa de motivo (fim de frase, mostrar um detalhe, continuar um gesto, voltar para a chamada final). Sem motivo, a pessoa continua falando.
- A-ROLL = cenas ugc_* (a mesma pessoa falando para a câmera com o produto). Planeje 2 a 4 A-rolls de até 8s cada, quebrando a fala em frases naturais.
- B-ROLL = detalhe contextual por cima do áudio do A-roll: use visualSource "reference_detail" (mão segurando, botões, bico, cabo, produto girando, mesma bancada/ambiente), 1 a 2,5s, entre dois A-rolls, com narration vazia. Não use product_image nem text_card no UGC (proibido: produto em fundo branco, flutuando, card de catálogo, foto centralizada em fundo desfocado, texto na imagem).
- Estrutura da fala: HOOK → observação neutra e honesta → produto → detalhe/demonstração → benefício informado → CTA curto ("tá no carrinho"). Frases curtas, português brasileiro natural, nada de tom de comercial.
- Cada A-roll fala no máximo ${Math.round(EDIT_POLICY.speechFillRatio * 100)}% do tempo disponível (deixe folga para respirar). Nunca invente especificações, números, experiência pessoal ou resultados.
- A última cena é o A-roll ugc_cta: a pessoa continua em cena; nada de card final.`;

export const campaignPlanPromptV1_6_0 = {
  ...campaignPlanPromptV1_5_0,
  version: "1.6.0",
  system: campaignPlanPromptV1_5_0.system + EDITOR_V2,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_5_0.buildUserMessage(input);
    return input.creativeMode === "ai_ugc" ? `${base}\nEditor V2: A-rolls ugc_* contínuos + B-rolls reference_detail entre eles.` : base;
  },
};
