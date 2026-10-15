import { campaignPlanPromptV1_2_0 } from "./campaign-plan.v1_2_0";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
export const campaignPlanPromptV1_3_0 = {
  ...campaignPlanPromptV1_2_0, version: "1.3.0",
  system: campaignPlanPromptV1_2_0.system.replace(
    "Presenter e product_ugc são tipos reservados: esta integração não suporta avatar ou lip sync; não os selecione.",
    "Presenter usa avatar Runway falando o áudio da narração ElevenLabs existente. Use presenter apenas se o pedido selecionar avatar; no mínimo uma cena curta quando selecionado. Product_ugc continua reservado: não o selecione. Todas as cenas devem ter narração quando houver presenter, para alinhamento. Não invente uso pessoal, teste, depoimento ou prova visual de claims.",
  ),
  buildUserMessage(input: CampaignPlanPromptInput) {
    return campaignPlanPromptV1_2_0.buildUserMessage(input) + (input.presenterPresetId ? `\nAvatar selecionado: ${input.presenterPresetId}. Use presenter em uma cena curta com fala sobre o produto.` : "\nSem avatar selecionado: não use presenter ou product_ugc.");
  },
};
