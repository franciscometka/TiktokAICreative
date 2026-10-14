import type { Usage } from "@/costs/calculate";
import type { RenderManifest } from "@/domain/render";

export interface RenderResult {
  outputUri: string;
  isMock: boolean;
  /** Consumo para precificação (ex.: { generations: 1 } para render local). */
  usage: Usage;
}

/**
 * Transforma um RenderManifest em MP4 1080x1920.
 * Implementação real (Remotion) chega em lote posterior; ver docs/TASKS.md.
 */
export interface Renderer {
  readonly id: string;
  readonly isMock: boolean;
  render(manifest: RenderManifest): Promise<RenderResult>;
}

/** Renderer FALSO: não gera arquivo. Retorna URI "mock://". */
export class MockRenderer implements Renderer {
  readonly id = "mock";
  readonly isMock = true;
  readonly renderCalls: RenderManifest[] = [];

  async render(manifest: RenderManifest): Promise<RenderResult> {
    this.renderCalls.push(manifest);
    return {
      outputUri: `mock://render/${manifest.creativeId}.mp4`,
      isMock: true,
      usage: { generations: 1, seconds: manifest.duration },
    };
  }
}
