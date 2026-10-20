import { normalizeCampaignPlanDerivedFields } from "../normalize-campaign-plan";
import { campaignPlanPromptV1_6_0 } from "./campaign-plan.v1_6_0";

const DERIVED_VIDEO_RULE = `

# Campo derivado de visualSource
- requiresGeneratedVideo=true para: generated_video, product_hero, product_demo, lifestyle, presenter, product_ugc, ugc_hook, ugc_demo, ugc_benefit, ugc_cta e product_broll.
- requiresGeneratedVideo=false para: product_image, text_card, screenshot, simple_background, existing_asset e reference_detail.
- O sistema deriva esse booleano novamente após receber o JSON; não use o campo para expressar uma decisão criativa diferente de visualSource.`;

/** 1.6.1 corrige a redundância de requiresGeneratedVideo sem alterar decisões criativas. */
export const campaignPlanPromptV1_6_1 = {
  ...campaignPlanPromptV1_6_0,
  version: "1.6.1",
  system: campaignPlanPromptV1_6_0.system + DERIVED_VIDEO_RULE,
  normalizeParsedOutput: normalizeCampaignPlanDerivedFields,
};
