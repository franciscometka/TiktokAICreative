import { expect, it } from "vitest";
import { campaignPlanPromptV1_4_0 as prompt } from "./campaign-plan.v1_4_0";
import { buildMockDraft } from "../mock-planner";
import { product } from "@/test/fixtures";
import { QUALITY_PRESETS } from "@/config/quality-presets";
it("envia o brief e recusa alteração silenciosa de roteiro manual na etapa REAL", () => {
  const request = { product: product(), styles: ["ugc" as const], creativeCount: 1, settings: QUALITY_PRESETS.economy, scriptMode: "manual" as const, script: "Texto definido por você.", videoConcept: "Detalhes do produto", projectName: "Meu projeto" };
  const message = prompt.buildUserMessage(request);
  expect(message).toContain(request.script); expect(message).toContain(request.videoConcept);
  const invalid = buildMockDraft({ ...request, scriptMode: "generate" });
  expect(prompt.validationSchemaFor(request).safeParse(invalid).success).toBe(false);
});
