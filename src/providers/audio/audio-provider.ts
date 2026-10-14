import type { CostQuote, MediaResult, ProviderDescriptor, ProviderJobRef, ProviderJobStatus } from "../types";

export interface AudioGenerationRequest {
  /** Identificador lógico do áudio (ex.: "narration"). */
  trackId: string;
  text: string;
  language: "pt-BR";
  voice?: string;
}

/** Contrato de qualquer provider de áudio/TTS (Mock, ElevenLabs...). Mesma regra de chamada paga do vídeo. */
export interface AudioProvider {
  readonly descriptor: ProviderDescriptor;
  estimateCost(request: AudioGenerationRequest): CostQuote;
  generateAudio(request: AudioGenerationRequest): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<MediaResult>;
}
