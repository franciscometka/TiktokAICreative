import type { VisualSource } from "@/domain/creative";
import type { RenderWarning, SceneAssetKind } from "@/domain/render";

/**
 * Mapa ÚNICO de tipo visual do domínio (VisualSource) → estratégia de composição.
 * - generated_video → vídeo do provider; enquanto o provider for mock, placeholder explícito.
 * - product_image → imagem real enviada + movimento.
 * - screenshot / existing_asset → ainda não há upload desses assets: usa imagem do produto se
 *   houver (fallback declarado em warning) ou card de texto.
 * - text_card / simple_background → composição tipográfica.
 */
export interface SceneStrategy {
  kind: SceneAssetKind;
  warning?: Omit<RenderWarning, "sceneId">;
}

export function sceneStrategy(source: VisualSource, hasProductImage: boolean): SceneStrategy {
  switch (source) {
    case "product_hero": case "product_demo": case "lifestyle": case "presenter": case "product_ugc":
    case "ugc_hook": case "ugc_demo": case "ugc_benefit": case "ugc_cta": case "product_broll":
    case "generated_video":
      return { kind: "generated_video" };
    // Editor V2: recorte do frame de referência; no caminho linear antigo cai na imagem do produto.
    case "reference_detail":
    case "product_image":
      return hasProductImage
        ? { kind: "product_image" }
        : {
            kind: "text_card",
            warning: { code: "product_image_missing", message: "Cena pede imagem do produto, mas nenhuma foi enviada; usando composição de texto." },
          };
    case "screenshot":
    case "existing_asset": {
      const label = source === "screenshot" ? "captura de tela" : "asset existente";
      return hasProductImage
        ? {
            kind: "product_image",
            warning: { code: "asset_not_provided", message: `Cena pede ${label}, que ainda não pode ser enviado; usando imagem do produto.` },
          }
        : {
            kind: "text_card",
            warning: { code: "asset_not_provided", message: `Cena pede ${label}, que ainda não pode ser enviado; usando composição de texto.` },
          };
    }
    case "text_card":
    case "simple_background":
      return { kind: "text_card" };
  }
}
