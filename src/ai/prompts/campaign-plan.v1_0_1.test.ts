import { describe, expect, it } from "vitest";
import { campaignPlanPromptV1 } from "./campaign-plan.v1";
import { campaignPlanPromptV1_0_1, HONESTY_RULES_V1_0_1 } from "./campaign-plan.v1_0_1";
import { ACTIVE_PROMPTS, PROMPTS } from "./registry";

describe("campaign-plan@1.0.1", () => {
  it("é a versão ativa; a 1.0.0 continua registrada para reprodutibilidade", () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.4.0");
    expect(PROMPTS.campaignPlan["1.0.0"].version).toBe("1.0.0");
    expect(PROMPTS.campaignPlan["1.0.0"].status).toBe("deprecated");
  });

  it("acrescenta SOMENTE as duas regras de honestidade da D42", () => {
    const v100 = campaignPlanPromptV1.system;
    const v101 = campaignPlanPromptV1_0_1.system;
    expect(v101.replace(`\n${HONESTY_RULES_V1_0_1}`, "")).toBe(v100);
    expect(HONESTY_RULES_V1_0_1.split("\n")).toHaveLength(2);
  });

  it("regra 1: proíbe experiência pessoal, compra, uso, teste ou depoimento inventados", () => {
    const s = campaignPlanPromptV1_0_1.system;
    expect(s).toContain("Sem experiência inventada");
    for (const term of ["comprou", "usou", "testou", "depoimento"]) expect(s).toContain(term);
  });

  it("regra 2: proíbe encenar alegação do vendedor como prova realizada", () => {
    const s = campaignPlanPromptV1_0_1.system;
    expect(s).toContain("Sem falsa prova");
    for (const term of ["timelapse", "relógio", "teste de vazamento", "prova realizada"]) expect(s).toContain(term);
  });

  it("as regras ficam na seção de honestidade, antes dos hooks", () => {
    const s = campaignPlanPromptV1_0_1.system;
    const honesty = s.indexOf("# Honestidade e conformidade");
    const rules = s.indexOf("Sem experiência inventada");
    expect(honesty).toBeGreaterThan(-1);
    expect(rules).toBeGreaterThan(honesty);
    expect(rules).toBeLessThan(s.indexOf("# Hooks"));
  });

  it("schema, validação, mensagem do usuário e limite de tokens não mudam", () => {
    expect(campaignPlanPromptV1_0_1.outputSchema).toBe(campaignPlanPromptV1.outputSchema);
    expect(campaignPlanPromptV1_0_1.buildUserMessage).toBe(campaignPlanPromptV1.buildUserMessage);
    expect(campaignPlanPromptV1_0_1.validationSchemaFor).toBe(campaignPlanPromptV1.validationSchemaFor);
    expect(campaignPlanPromptV1_0_1.maxTokensFor).toBe(campaignPlanPromptV1.maxTokensFor);
  });
});
