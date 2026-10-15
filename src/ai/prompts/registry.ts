import { campaignPlanPromptV1_4_0 } from "./campaign-plan.v1_4_0";
import { campaignPlanPromptV1_3_0 } from "./campaign-plan.v1_3_0";
import { campaignPlanPromptV1_2_0 } from "./campaign-plan.v1_2_0";
import { campaignPlanPromptV1 } from "./campaign-plan.v1";
import { campaignPlanPromptV1_0_1 } from "./campaign-plan.v1_0_1";

/**
 * Registro central de prompts. Todo prompt do projeto vive em ai/prompts/ e é
 * referenciado por aqui — nada de strings de prompt espalhadas em outros módulos.
 * Versões antigas permanecem no arquivo para reprodutibilidade/comparação.
 */
export const PROMPTS = {
  campaignPlan: {
    "1.0.0": { ...campaignPlanPromptV1, status: "deprecated" as const },
    "1.0.1": campaignPlanPromptV1_0_1,
    "1.2.0": campaignPlanPromptV1_2_0,
    "1.3.0": campaignPlanPromptV1_3_0,
    "1.4.0": campaignPlanPromptV1_4_0,
  },
} as const;

/** Versão em uso de cada prompt. Trocar versão = uma linha aqui. */
export const ACTIVE_PROMPTS = {
  campaignPlan: PROMPTS.campaignPlan["1.4.0"],
} as const;
