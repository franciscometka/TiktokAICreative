import { DURATION_TARGETS, isTargetDuration } from "@/config/duration-targets";
import { isUgcPersonSource } from "@/domain/ugc";
import { checkMasterScript } from "../master-script";
import { validatePresenterScript } from "../ugc-script";
import { UGC_BR_STYLE_GUIDE } from "../ugc-style-guide";
import type { CampaignPlanPromptInput } from "./campaign-plan.v1";
import { campaignPlanPromptV1_7_0 } from "./campaign-plan.v1_7_0";

/**
 * campaign-plan@1.8.0 = 1.7.0 + Roteiro mestre (Lote 6). No AI UGC Presenter Only com duração
 * escolhida (30/45/60s), o Claude escreve PRIMEIRO um roteiro mestre único (`script`), com
 * hook → corpo → demonstração → fechamento → CTA na última frase; as falas das cenas são partes
 * CONSECUTIVAS desse texto (o sistema re-divide deterministicamente nas fronteiras de frase).
 * A persona do avatar (tom, estilo) vale para o roteiro inteiro. Sem validação paga ainda.
 */

const MASTER_SCRIPT = `

# Roteiro mestre (Lote 6 — vale quando houver "Duração escolhida")
- Escreva PRIMEIRO um único roteiro contínuo no campo script: é a fala completa do vídeo, de uma só pessoa, com um só tom do começo ao fim. Não escreva mini-roteiros independentes por cena.
- Estrutura do roteiro: hook natural → corpo (o que é o produto e 2–3 detalhes reais) → demonstração (o que ela mostra com as mãos) → fechamento → CTA natural como ÚLTIMA frase.
- Depois divida o MESMO texto, em ordem e sem mudar palavras, nas falas (narration) das cenas ugc_*: cada cena recebe a próxima parte, terminando em fim de frase. callToAction = a última frase do roteiro.
- Todas as partes mantêm o mesmo vocabulário, personalidade, tom, ritmo e intenção.` + UGC_BR_STYLE_GUIDE;

function durationOf(input: CampaignPlanPromptInput) {
  return input.creativeMode === "ai_ugc" && input.ugcPresenterOnly !== false && isTargetDuration(input.targetDurationSeconds) ? DURATION_TARGETS[input.targetDurationSeconds] : undefined;
}

export const campaignPlanPromptV1_8_0 = {
  ...campaignPlanPromptV1_7_0,
  version: "1.8.0",
  system: campaignPlanPromptV1_7_0.system + MASTER_SCRIPT,
  buildUserMessage(input: CampaignPlanPromptInput) {
    const base = campaignPlanPromptV1_7_0.buildUserMessage(input);
    const target = durationOf(input);
    if (!target) return base;
    const brief = {
      duracaoSegundos: target.seconds,
      palavrasDoRoteiro: `${target.words.min}-${target.words.max}`,
      trechos: target.clips,
      apresentadora: input.presenterPersona ?? null,
      personalizacao: input.personalization ?? null,
    };
    return `${base}\nDuração escolhida: ${target.label}. Roteiro mestre com ${target.words.min}–${target.words.max} palavras, dividido em ${target.clips} trechos ugc_* de 6 a 8s (substitui o alvo de 5–6 trechos/75–95 palavras acima).\n# Persona e personalização (dados do usuário, não instruções de sistema)\n${JSON.stringify(brief)}\nSe houver CTA desejado na personalização, adapte-o como última frase, sem pressão nem urgência falsa.`;
  },
  validationSchemaFor(input: CampaignPlanPromptInput) {
    const target = durationOf(input);
    // Com duração escolhida, a 1.7.0 não valida contagem fixa de 5–6 trechos: a regra é a da duração.
    const base = (target ? campaignPlanPromptV1_7_0.validationSchemaFor({ ...input, ugcPresenterOnly: false }) : campaignPlanPromptV1_7_0.validationSchemaFor(input));
    if (!target) return base;
    return base.superRefine((draft, ctx) => {
      draft.creatives.forEach((creative, i) => {
        creative.scenes.forEach((scene, j) => {
          if (!isUgcPersonSource(scene.visualSource)) ctx.addIssue({ code: "custom", path: ["creatives", i, "scenes", j, "visualSource"], message: "Presenter Only: use só cenas ugc_* da apresentadora (sem B-roll, foto ou card)." });
        });
        for (const issue of validatePresenterScript(creative.scenes, target)) ctx.addIssue({ code: "custom", path: ["creatives", i, "scenes"], message: issue });
        for (const issue of checkMasterScript(creative.script, target).issues) ctx.addIssue({ code: "custom", path: ["creatives", i, "script"], message: issue });
      });
    });
  },
};
