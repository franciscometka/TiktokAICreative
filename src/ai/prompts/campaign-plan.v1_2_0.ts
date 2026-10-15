import { campaignPlanPromptV1_0_1 } from "./campaign-plan.v1_0_1";
export const campaignPlanPromptV1_2_0 = {
  ...campaignPlanPromptV1_0_1,
  version: "1.2.0",
  system: campaignPlanPromptV1_0_1.system.replace(
    'visualSource = "generated_video"',
    'visualSource for um tipo gerado (generated_video, product_hero, product_demo, lifestyle, presenter, product_ugc)',
  ) + `
# Direção visual
Prefira product_hero (produto inteiro, locked ou lateral_slide leve), product_demo (câmera locked e uma ação física), lifestyle (handheld suave).
Presenter e product_ugc são tipos reservados: esta integração não suporta avatar ou lip sync; não os selecione.
Para cenas geradas preencha videoDirection: framing (full_product, product_detail, in_context, person_medium), camera (locked, lateral_slide, handheld, slow_dolly_in, slow_dolly_out, orbit_arc, pan, tilt), subjectAction e ambientMotion (frases curtas em inglês), pacing (calm, steady, energetic).
Descreva movimento e câmera; a foto já descreve a aparência. Não use slow push-in ou zoom como padrão. Produto inteiro com espaço ao redor. Product demo: uma ação compatível com o produto; lifestyle: movimento natural do ambiente.
Pessoas não dão depoimentos nem alegam ter usado o produto; nada encenado serve como prova.
`,
};
