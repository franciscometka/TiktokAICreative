import { describe, expect, it } from "vitest";
import { presenterSceneViews } from "./presenter-view";
import { AvatarPresetSchema } from "@/domain/presenter";
import { campaignPlanPromptV1_3_0 } from "@/ai/prompts/campaign-plan.v1_3_0";
import { campaignRequest, createHarness } from "@/test/fixtures";
describe("seleção e apresentação do avatar", () => {
  it("preset válido chega ao plano, custo e painel sem caminhos locais", async () => {
    const h = createHarness();
    const campaign = await h.service.planCampaign(campaignRequest({ presenterPresetId: "cooking-teacher" }));
    const job = await h.service.getJob(campaign.jobIds[0]!);
    const plan = campaign.plan!.creatives[0]!;
    expect(presenterSceneViews(campaign, plan, job)).toMatchObject([{ avatar: "cooking-teacher", status: "Aguardando aprovação/narração", videoUrl: null }]);
    expect(job.estimate!.breakdown.some(l => l.model === "gwm1_avatars")).toBe(true);
    expect(AvatarPresetSchema.safeParse("arbitrary-avatar").success).toBe(false);
  });
  it("planner pede presenter só quando selecionado e mantém regras de honestidade", async () => {
    const h = createHarness();
    const request = { product: campaignRequest().product, styles: campaignRequest().styles, creativeCount: 1, settings: h.settings };
    expect(campaignPlanPromptV1_3_0.buildUserMessage(request)).toContain("Sem avatar selecionado");
    expect(campaignPlanPromptV1_3_0.buildUserMessage({ ...request, presenterPresetId: "influencer" })).toContain("Avatar selecionado: influencer");
    expect(campaignPlanPromptV1_3_0.system).toContain("Não invente uso pessoal, teste, depoimento ou prova visual");
  });
});
