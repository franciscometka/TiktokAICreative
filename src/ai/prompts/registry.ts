import { campaignPlanPromptV1 } from "./campaign-plan.v1";

/**
 * Registro central de prompts. Todo prompt do projeto vive em ai/prompts/ e é
 * referenciado por aqui — nada de strings de prompt espalhadas em outros módulos.
 * Versões antigas permanecem no arquivo para reprodutibilidade/comparação.
 */
export const PROMPTS = {
  campaignPlan: {
    "1.0.0": campaignPlanPromptV1,
  },
} as const;

/** Versão em uso de cada prompt. Trocar versão = uma linha aqui. */
export const ACTIVE_PROMPTS = {
  campaignPlan: PROMPTS.campaignPlan["1.0.0"],
} as const;
