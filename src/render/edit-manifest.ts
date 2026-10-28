import { EDIT_POLICY } from "@/config/edit-policy";
import type { CreativePlan } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import { RenderManifestSchema, VIDEO_FORMAT, type ManifestAsset, type RenderManifest } from "@/domain/render";
import { buildEditPlan, type EditClip } from "./edit-plan";
import { buildPresenterEditPlan } from "./presenter-edit-plan";
import { PRESENTER_EDIT_PLAN_VERSION } from "@/domain/edit";

export interface BuildEditedManifestInput {
  campaignId: string;
  plan: CreativePlan;
  product: ProductInput;
  /** sceneId → clipe ativo (A-rolls e B-roll gerado), com duração real e gerada. */
  clips: ReadonlyMap<string, EditClip>;
  /** Frame de referência aprovado (B-roll de detalhe). */
  referenceImageUri?: string;
  outputDir: string;
}

/**
 * Creative Editor V2 → RenderManifest. O manifest carrega o Edit Plan completo (`edit`) e uma lista
 * de assets compatível (um por trecho visual) para o AssetResolver autorizar cada arquivo. Não há
 * narração separada: o áudio vem das faixas de A-roll do Edit Plan (fala nativa).
 */
export function buildEditedRenderManifest(input: BuildEditedManifestInput): RenderManifest {
  const { plan, product } = input;
  const cta = plan.scenes.findLast((s) => s.edit?.role === "aroll" && s.visualSource === "ugc_cta")?.onScreenText.trim();
  const hookScene = plan.scenes[0];
  // Lote 5.7: Presenter Only (V3) — só A-rolls, sem hook textual, CTA pequeno opcional no fim.
  const edit = plan.editPlanVersion === PRESENTER_EDIT_PLAN_VERSION ? buildPresenterEditPlan({ plan, clips: input.clips, ctaLabel: cta || undefined }) : buildEditPlan({
    plan,
    clips: input.clips,
    referenceImageUri: input.referenceImageUri,
    productImageUri: product.images[0]?.uri,
    ctaLabel: cta || EDIT_POLICY.ctaLabel,
    hookText: hookScene?.onScreenText,
  });
  const byScene = new Map(plan.scenes.map((s) => [s.id, s]));
  const assets: ManifestAsset[] = edit.visuals.map((segment) => {
    const scene = byScene.get(segment.sceneId)!;
    return {
      sceneId: segment.sceneId,
      kind: segment.media === "video" ? "generated_video" : "product_image",
      uri: segment.uri,
      startSeconds: segment.startSeconds,
      durationSeconds: Math.round((segment.endSeconds - segment.startSeconds) * 1000) / 1000,
      motion: "none",
      shotType: scene.shotType,
      onScreenText: "",
      visualSource: scene.visualSource,
      visualDescription: scene.visualDescription,
      ...(segment.role === "aroll" ? { clipAudio: true } : {}),
    };
  });
  return RenderManifestSchema.parse({
    campaignId: input.campaignId,
    creativeId: plan.id,
    assets,
    audio: [],
    captions: edit.captions.map((c) => ({ text: c.text, startSeconds: c.startSeconds, endSeconds: c.endSeconds })),
    captionSource: "estimated",
    // V3: legenda mapeada às pausas medidas (ainda sem ASR); o rótulo "estimated" é mantido.
    extendedSeconds: 0,
    overlays: { productName: product.name, priceBrl: product.priceBrl, callToAction: plan.callToAction, hook: edit.hook?.text, benefit: product.benefits[0] },
    duration: edit.durationSeconds,
    generatedVideoSeconds: edit.usage.reduce((sum, u) => sum + u.generatedSeconds, 0),
    output: { ...VIDEO_FORMAT, path: `${input.outputDir}/renders/${input.campaignId}/${plan.id}` },
    warnings: (edit.warnings ?? []).map((message) => ({ sceneId: null, code: "edit_plan" as const, message })),
    edit,
  });
}
