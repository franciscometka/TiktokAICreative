import type { CampaignPlanDraft } from "@/domain/campaign";
import { campaignPlanPromptV1, type CampaignPlanPromptInput } from "./campaign-plan.v1";
import type { PromptDefinition } from "./types";

/**
 * campaign-plan@1.0.1 = 1.0.0 + as duas regras de honestidade da DECISIONS D42 (SPEC, "Regras de
 * conteúdo" 5 e 6). Nada mais muda: mesmo schema de saída, mesma validação, mesma mensagem do
 * usuário. Correção mínima (patch), sem nova validação real com o Claude neste lote.
 */

/** Linha do 1.0.0 depois da qual as regras novas entram (seção "Honestidade e conformidade"). */
const ANCHOR =
  "- Quando faltar informação que deixaria o criativo mais forte (medidas, materiais, prova social, garantia, prazo de entrega), liste em missingInformation em vez de supor.";

export const HONESTY_RULES_V1_0_1 = [
  '- Sem experiência inventada: narração e falas nunca afirmam que o narrador ou o ator comprou, usou, testou ou obteve algum resultado com o produto ("comprei e amei", "uso todo dia", "testei por uma semana", "minha água ficou gelada até a noite"), nem trazem depoimento, a menos que isso esteja nas informações fornecidas. Apresente o produto e o que ele oferece ("essa garrafa mantém a água gelada"), não uma experiência pessoal.',
  '- Sem falsa prova: alegações informadas pelo vendedor (tempo de conservação, vedação, resistência, durabilidade — ex.: "gelado por 24h", "não vaza") aparecem como informação do produto na narração ou no texto da tela, nunca encenadas como se a cena comprovasse o fato. Não planeje relógio avançando, timelapse de "24 horas depois", teste de vazamento, queda ou comparação lado a lado apresentados como prova realizada.',
].join("\n");

function systemV1_0_1(base: string): string {
  if (!base.includes(ANCHOR)) throw new Error("campaign-plan@1.0.1: âncora não encontrada no prompt 1.0.0");
  return base.replace(ANCHOR, `${ANCHOR}\n${HONESTY_RULES_V1_0_1}`);
}

export const campaignPlanPromptV1_0_1: PromptDefinition<CampaignPlanPromptInput, CampaignPlanDraft> = {
  ...campaignPlanPromptV1,
  version: "1.0.1",
  status: "active",
  system: systemV1_0_1(campaignPlanPromptV1.system),
};
