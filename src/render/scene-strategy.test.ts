import { describe, expect, it } from "vitest";
import { VISUAL_SOURCES } from "@/domain/creative";
import { SceneAssetKindSchema } from "@/domain/render";
import { sceneStrategy } from "./scene-strategy";

describe("VisualSource → estratégia visual", () => {
  it("cobre todos os VisualSource do domínio (sem enum paralelo)", () => {
    for (const source of VISUAL_SOURCES) {
      expect(SceneAssetKindSchema.options).toContain(sceneStrategy(source, true).kind);
      expect(SceneAssetKindSchema.options).toContain(sceneStrategy(source, false).kind);
    }
  });

  it("mapeia os tipos diretos sem aviso", () => {
    expect(sceneStrategy("generated_video", false)).toEqual({ kind: "generated_video" });
    expect(sceneStrategy("product_image", true)).toEqual({ kind: "product_image" });
    expect(sceneStrategy("text_card", true)).toEqual({ kind: "text_card" });
    expect(sceneStrategy("simple_background", true)).toEqual({ kind: "text_card" });
  });

  it("imagem do produto pedida sem upload → card de texto com aviso", () => {
    expect(sceneStrategy("product_image", false)).toMatchObject({ kind: "text_card", warning: { code: "product_image_missing" } });
  });

  it("screenshot/asset existente ainda não enviados → fallback declarado em aviso", () => {
    expect(sceneStrategy("screenshot", true)).toMatchObject({ kind: "product_image", warning: { code: "asset_not_provided" } });
    expect(sceneStrategy("existing_asset", false)).toMatchObject({ kind: "text_card", warning: { code: "asset_not_provided" } });
    expect(sceneStrategy("screenshot", false).warning?.message).toContain("captura de tela");
  });
});
