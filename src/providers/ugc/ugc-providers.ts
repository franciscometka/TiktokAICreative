import type { SceneContinuity } from "@/domain/edit";
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
  /** Request id do provider, quando informado (auditoria). */
  requestId?: string;
  /** Metadados não sensíveis (tokens de uso, versão do modelo). */
  metadata?: Record<string, string | number>;
}

/** Metadados duráveis de uma entrada preparada antes da criação paga. */
export interface UgcPreparedReference {
  metadata: Record<string, string | number | boolean>;
}

/** UGCReferenceProvider: gera a imagem pessoa + produto. */
export interface UgcReferenceProvider {
  readonly descriptor: ProviderDescriptor;
  estimateCost(): CostQuote;
  /** Opcional: upload/validação não paga, persistida pelo pipeline antes do POST de geração. */
  prepare?(request: UgcReferenceRequest, previous?: Record<string, string | number | boolean>): Promise<UgcPreparedReference>;
  submit(request: UgcReferenceRequest, prepared?: UgcPreparedReference): Promise<ProviderJobRef>;
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
  /** Editor V2: como a cena anterior termina e como esta deve começar/terminar. */
  continuity?: SceneContinuity;
  /** Lote 5.7: último trecho (CTA falado) — pede ~1s de cena natural, sem fala, depois da última palavra. */
  finalTail?: boolean;
  /** Editor V2: linhas de fidelidade do produto (textos/números/logo não mudam). */
  fidelity?: readonly string[];
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
  prepare?(request: UgcVideoRequest, previous?: Record<string, string | number | boolean>): Promise<UgcPreparedReference>;
  submit(request: UgcVideoRequest, prepared?: UgcPreparedReference): Promise<ProviderJobRef>;
  getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus>;
  downloadResult(ref: ProviderJobRef): Promise<UgcVideoResult>;
}
