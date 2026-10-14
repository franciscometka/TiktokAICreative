import type { AppConfig } from "@/config/env";
import type { RenderManifest } from "@/domain/render";
import type { RemotionRendererOptions } from "./remotion/remotion-renderer";
import { MockRenderer, type Renderer, type RenderOptions, type RenderResult } from "./renderer";

export type RendererId = AppConfig["renderer"]["id"];

/**
 * Carrega o RemotionRenderer só no primeiro render: com RENDERER=mock (testes, CI) o Remotion
 * nem é importado. O bundle fica em cache dentro da instância (um por processo).
 */
export class LazyRemotionRenderer implements Renderer {
  readonly id = "remotion";
  readonly isMock = false;
  private inner: Promise<Renderer> | undefined;

  constructor(private readonly options: RemotionRendererOptions) {}

  render(manifest: RenderManifest, options?: RenderOptions): Promise<RenderResult> {
    this.inner ??= import("./remotion/remotion-renderer").then((m) => new m.RemotionRenderer(this.options));
    return this.inner.then((renderer) => renderer.render(manifest, options));
  }
}

/** ÚNICO lugar que escolhe o renderer (RENDERER=mock|remotion). */
export function createRenderer(id: RendererId, options: RemotionRendererOptions): Renderer {
  switch (id) {
    case "mock":
      return new MockRenderer();
    case "remotion":
      return new LazyRemotionRenderer(options);
  }
}
