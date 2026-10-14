import type { CharacterTiming, SpeechLanguage } from "@/domain/audio";
import type { CostQuote, MediaResult, ProviderDescriptor, ProviderJobRef, ProviderJobStatus } from "../types";

export interface AudioGenerationRequest {
  /** Identificador lógico do áudio (ex.: "narration"). */
  trackId: string;
  /** Texto FALADO (já normalizado). A cobrança é por caractere deste texto. */
  text: string;
  language: SpeechLanguage;
  /** Perfil de voz interno (config/voices.ts); cada provider mapeia para a sua voz. */
  speakerProfileId: string;
}

/**
 * Resultado de áudio já em tipos INTERNOS: bytes do arquivo (quando real), timing por caractere
 * do texto enviado e o request id do provider. Quem persiste o arquivo é o pipeline
 * (AudioAssetStore), não o provider.
 */
export interface AudioResult extends MediaResult {
  /** Bytes do arquivo (ausente no mock, que não gera áudio). */
  data?: Uint8Array;
  extension?: "mp3";
  /** Timing real por caractere do texto enviado (ausente quando o provider não informa). */
  characterTiming?: CharacterTiming;
  requestId?: string;
  voiceId?: string;
  /** Caracteres cobrados informados pelo provider. */
  billedCharacters?: number;
}

/** Contrato de qualquer provider de áudio/TTS (Mock, ElevenLabs...). Mesma regra de chamada paga do vídeo. */
export interface AudioProvider {
  readonly descriptor: ProviderDescriptor;
  estimateCost(request: AudioGenerationRequest): CostQuote;
  generateAudio(request: AudioGenerationRequest): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<AudioResult>;
}
