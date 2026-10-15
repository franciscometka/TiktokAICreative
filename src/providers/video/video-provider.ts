import type { VisualSource } from "@/domain/creative";
import type { CostQuote, MediaResult, ProviderDescriptor, ProviderJobRef, ProviderJobStatus } from "../types";

export interface VideoGenerationRequest {
  sceneId: string;
  visualSource?: VisualSource;
  prompt: string;
  durationSeconds: number;
  aspectRatio: "9:16";
  referenceImageUris: readonly string[];
}

/**
 * Contrato de qualquer provider de vídeo (Mock, Veo, Runway, Kling...).
 * O domínio e o pipeline só conhecem esta interface.
 *
 * generateScene() é uma chamada PAGA em providers reais: só o pipeline pode chamá-la,
 * e apenas depois de passar pelo guard de aprovação/orçamento (pipeline/guards.ts).
 */
export interface VideoProvider {
  readonly descriptor: ProviderDescriptor;
  validateRequest?(request: VideoGenerationRequest): Promise<unknown>;
  estimateCost(request: VideoGenerationRequest): CostQuote;
  generateScene(request: VideoGenerationRequest): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<MediaResult>;
}
