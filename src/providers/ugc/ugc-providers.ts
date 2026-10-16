import type { UgcAudioStrategy, UgcCharacterIdentity, UgcPersonSource, UgcProductAnchor } from "@/domain/ugc";
import type { CostQuote, MediaResult, ProviderDescriptor, ProviderJobRef, ProviderJobStatus } from "../types";

/**
 * Contratos do AI UGC (Lote 5.3). DELIBERADAMENTE separados de PresenterProvider (avatar dirigido
 * por áudio) e de VideoProvider (vídeo de produto): aqui uma pessoa realista segura o produto real.
 * Implementações: mocks (hoje) e, no futuro, um provider oficial (ex.: Google/Veo via API) — nunca
 * automação da interface web do Flow.
 */

export interface UgcReferenceRequest {
  /** Foto ORIGINAL do produto (URI relativa autorizada; o provider real lê pelo AssetResolver). */
  product: UgcProductAnchor;
  identity: UgcCharacterIdentity;
  /** Prompt montado por `buildUgcReferencePrompt` (determinístico, versionado no job). */
  prompt: string;
  aspectRatio: "9:16";
}

export interface UgcImageResult {
  uri: string;
  mimeType: string;
  /** Bytes da imagem (ausente no mock). Quem persiste é o pipeline (UgcAssetStore). */
  data?: Uint8Array;
  width: number;
  height: number;
  billedUsage: MediaResult["billedUsage"];
  isMock: boolean;
}

/** UGCReferenceProvider: gera a imagem pessoa + produto. */
export interface UgcReferenceProvider {
  readonly descriptor: ProviderDescriptor;
  estimateCost(): CostQuote;
  submit(request: UgcReferenceRequest): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<UgcImageResult>;
}

export interface UgcVideoRequest {
  sceneId: string;
  role: UgcPersonSource;
  /** Referência APROVADA (pessoa + produto). Sem ela não existe pedido. */
  reference: { id: string; version: string; imageUri: string; approved: true };
  identity: UgcCharacterIdentity;
  product: UgcProductAnchor;
  /** Fala da cena (native_speech: o modelo fala este texto; external_lipsync: só contexto). */
  speech: string;
  /** Ação/movimento da pessoa com o produto. */
  action: string;
  durationSeconds: number;
  aspectRatio: "9:16";
  /** Referências extras (produto/pessoa) para modelos que suportam referenceImages; máximo 3. */
  additionalReferenceUris?: readonly string[];
  /** Ajuda a consistência quando suportado, mas NÃO garante determinismo. */
  seed?: number;
  /** external_lipsync: trecho da narração ElevenLabs (bytes WAV) + janela no áudio contínuo. */
  audio?: { data: Uint8Array; startSeconds: number; endSeconds: number; narrationVersion: string };
}

export interface UgcVideoResult extends MediaResult {
  data?: Uint8Array;
  /** O clipe traz a fala? (native_speech = true). O render nunca soma outra voz por cima. */
  hasAudio: boolean;
  requestedDurationSeconds?: number;
  providerReportedDurationSeconds?: number;
}

/** UGCVideoProvider: transforma a referência aprovada em vídeo da pessoa falando. */
export interface UgcVideoProvider {
  readonly descriptor: ProviderDescriptor;
  /** Estratégia de áudio DECLARADA pelo provider (ver UgcAudioStrategy). */
  readonly audioStrategy: UgcAudioStrategy;
  readonly capabilities?: { supportsReferenceImages: boolean; maxReferenceImages: number; supportsSeed: boolean; nativeAudio: boolean };
  estimateCost(seconds: number): CostQuote;
  submit(request: UgcVideoRequest): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<UgcVideoResult>;
}
