import type { Usage } from "@/costs/calculate";
import type { RenderManifest, RenderWarning } from "@/domain/render";

export interface RenderProgress {
  renderedFrames: number;
  totalFrames: number;
}

export interface RenderOptions {
  /** Versão desejada (ex.: 2 → "v2"); o renderer usa a próxima livre, nunca sobrescreve. */
  preferredVersion?: number;
  /** Progresso REAL informado pelo renderer (frames). Mock não informa. */
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderResult {
  outputUri: string;
  isMock: boolean;
  /** Consumo para precificação (ex.: { generations: 1 } para render local). */
  usage: Usage;
  /** Versão gravada em disco (ex.: "v1"). Ausente no mock. */
  renderId?: string;
  manifestUri?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  totalFrames?: number;
  renderMs?: number;
  /** Situações esperadas (placeholder de IA, sem áudio, asset ausente). Nunca erros de segurança. */
  warnings: RenderWarning[];
}

/**
 * Transforma um RenderManifest em MP4 1080x1920.
 * Implementações: MockRenderer (testes) e RemotionRenderer (src/render/remotion/, RENDERER=remotion).
 */
export interface Renderer {
  readonly id: string;
  readonly isMock: boolean;
  render(manifest: RenderManifest, options?: RenderOptions): Promise<RenderResult>;
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
      warnings: manifest.warnings,
    };
  }
}
