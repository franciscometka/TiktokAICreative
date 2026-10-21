import { campaignPlanPromptV1_6_0 } from "./campaign-plan.v1_6_0";
import { campaignPlanPromptV1_6_1 } from "./campaign-plan.v1_6_1";
import { campaignPlanPromptV1_7_0 } from "./campaign-plan.v1_7_0";
import { campaignPlanPromptV1_8_0 } from "./campaign-plan.v1_8_0";
import { campaignPlanPromptV1_8_1 } from "./campaign-plan.v1_8_1";
import { campaignPlanPromptV1_9_0 } from "./campaign-plan.v1_9_0";
import { campaignPlanPromptV1_5_0 } from "./campaign-plan.v1_5_0";
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
    "1.5.0": campaignPlanPromptV1_5_0,
    "1.6.0": campaignPlanPromptV1_6_0,
    "1.6.1": campaignPlanPromptV1_6_1,
    "1.7.0": campaignPlanPromptV1_7_0,
    "1.8.0": campaignPlanPromptV1_8_0,
    "1.8.1": campaignPlanPromptV1_8_1,
    "1.9.0": campaignPlanPromptV1_9_0,
  },
} as const;

/** Versão em uso de cada prompt. Trocar versão = uma linha aqui. */
export const ACTIVE_PROMPTS = {
  campaignPlan: PROMPTS.campaignPlan["1.9.0"],
} as const;
