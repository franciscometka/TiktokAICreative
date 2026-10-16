import { createHash } from "node:crypto";
import { costForUsage } from "@/costs/calculate";
import {
  KREA_REFERENCE_ENDPOINT,
  KREA_UGC_PROVIDER,
  kreaRequestedDuration,
  kreaVeoConfigForPricingModel,
  type KreaVeoConfig,
  type KreaVeoDuration,
} from "@/config/krea-ugc-models";
import type { ProviderPricing } from "@/domain/cost";
import { detectImageType } from "@/domain/upload";
import { imageDimensions } from "@/render/image-dimensions";
import { inspectMp4 } from "../video/mp4";
import { ProviderError, type ProviderJobRef, type ProviderJobStatus } from "../types";
import type { KreaHttpClient, KreaJob } from "./krea-http";
import type { UgcImageResult, UgcPreparedReference, UgcReferenceProvider, UgcReferenceRequest, UgcVideoProvider, UgcVideoRequest, UgcVideoResult } from "./ugc-providers";

/** Lê imagem LOCAL autorizada (uploads/UGC) já validada; mesma assinatura do leitor Google. */
export type KreaImageLoader = (uri: string) => Promise<{ data: Uint8Array; mimeType: string }>;

/** Corpo de `POST /generate/image/google/nano-banana-2` (OpenAPI Krea). */
export interface KreaReferenceBody {
  prompt: string;
  image_urls: string[];
  aspect_ratio: "9:16";
  resolution: "1K";
}

/** Corpo de `POST /generate/video/google/veo-3.1[-fast]` (OpenAPI Krea). */
export interface KreaVeoBody {
  prompt: string;
  start_image: string;
  aspect_ratio: "9:16";
  duration: KreaVeoDuration;
  generate_audio: true;
  resolution: KreaVeoConfig["resolution"];
}

/** Builder PURO do corpo da referência; `productUrl` é a URL do asset já enviado à Krea. */
export function buildKreaReferenceBody(request: UgcReferenceRequest, productUrl: string): KreaReferenceBody {
  if (request.aspectRatio !== "9:16") throw new Error("AI UGC Krea deve permanecer em 9:16.");
  return {
    prompt: `${request.prompt}\nEdit the supplied product image into a portrait 9:16 UGC reference. Preserve exactly: ${request.product.preserve.join(", ")}. Do not redesign, relabel or reshape the product. The person must be synthetic and adult.`,
    image_urls: [productUrl],
    aspect_ratio: "9:16",
    resolution: "1K",
  };
}

/** Builder PURO do corpo do Veo: start_image = referência APROVADA; fala nativa obrigatória. */
export function buildKreaVeoBody(request: UgcVideoRequest, config: KreaVeoConfig, startImageUrl: string): KreaVeoBody {
  if (!request.reference.approved) throw new Error("Veo (Krea) exige uma referência UGC aprovada.");
  if (request.audio) throw new Error("Veo 3.1 (Krea) usa áudio nativo: não envie narração ElevenLabs.");
  if (request.aspectRatio !== "9:16") throw new Error("AI UGC Krea deve permanecer em 9:16.");
  if ((request.additionalReferenceUris ?? []).length > 0) throw new Error("AI UGC Krea usa só a referência aprovada (pessoa + produto) como start_image.");
  return {
    prompt: `${request.action}. Keep the same adult synthetic person, face, hair, wardrobe, environment and exact product identity. Preserve product shape, colors, logo, packaging and proportions. The person says naturally in Brazilian Portuguese: "${request.speech}"`,
    start_image: startImageUrl,
    aspect_ratio: "9:16",
    duration: kreaRequestedDuration(request.durationSeconds),
    generate_audio: true,
    resolution: config.resolution,
  };
}

/**
 * ID persistido pelo pipeline: `krea:<job_id>` ou `krea:<job_id>:<s>s` (vídeo). A duração COMPRADA
 * viaja no próprio ID → custo real correto mesmo após reinício, sem estado em memória.
 */
const REF_ID = /^krea:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?::(4|6|8)s)?$/i;
export function parseKreaJobRef(providerJobId: string): { jobId: string; seconds?: KreaVeoDuration } {
  const match = REF_ID.exec(providerJobId);
  if (!match) throw new ProviderError("Job ID da Krea inválido.");
  return { jobId: match[1]!, ...(match[2] ? { seconds: Number(match[2]) as KreaVeoDuration } : {}) };
}

const RUNNING: readonly KreaJob["status"][] = ["processing", "sampling", "intermediate-complete"];

function status(http: KreaHttpClient, providerJobId: string, job: KreaJob): ProviderJobStatus {
  if (job.status === "completed") {
    return { providerJobId, state: "succeeded" };
  }
  if (job.status === "failed" || job.status === "cancelled") {
    const error = http.error({ kind: "provider", providerCode: job.errorCode ?? job.status.toUpperCase(), providerMessage: job.errorMessage, billing: "rejected" }, "failed_after_job", job.jobId);
    return { providerJobId, state: "failed", error: error.message, diagnostic: error.diagnostic };
  }
  return { providerJobId, state: RUNNING.includes(job.status) ? "running" : "queued" };
}

async function completedUrl(http: KreaHttpClient, jobId: string, billedUsage: { generations?: number; seconds?: number }): Promise<string> {
  const job = await http.getJob(jobId);
  if (job.status !== "completed") throw http.error({ kind: "invalid_response", billing: "unconfirmed" }, "uncertain", jobId);
  if (!job.urls[0]) throw http.error({ kind: "invalid_response", providerCode: "NO_RESULT", billing: "confirmed" }, "failed_after_job", jobId, billedUsage);
  return job.urls[0];
}

/** Nano Banana 2 via Krea: upload da foto do produto (`/assets`) → job pago → polling → PNG/JPEG. */
export class UgcReferenceProviderKrea implements UgcReferenceProvider {
  readonly descriptor;

  constructor(private readonly pricing: ProviderPricing, private readonly http: KreaHttpClient, private readonly loadImage: KreaImageLoader) {
    if (pricing.provider !== KREA_UGC_PROVIDER) throw new ProviderError("Preço não pertence à Krea.");
    this.descriptor = { id: KREA_UGC_PROVIDER, model: pricing.model, isMock: false, pricing };
  }

  estimateCost() {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { generations: 1 }), pricing: this.pricing };
  }

  async prepare(request: UgcReferenceRequest, previous?: Record<string, string | number | boolean>): Promise<UgcPreparedReference> {
    const product = await this.loadImage(request.product.imageUri);
    const sourceHash = createHash("sha256").update(product.data).digest("hex");
    const priorId = previous?.kreaAssetId;
    if (previous?.kreaAssetHash === sourceHash && previous?.kreaAssetProvider === KREA_UGC_PROVIDER && previous?.kreaAssetVersion === 1 && typeof priorId === "string") {
      const current = await this.http.getAsset(priorId);
      if (current) return { metadata: this.assetMetadata(current, sourceHash) };
    }
    const uploaded = await this.http.uploadAsset(product.data, product.mimeType, "product");
    return { metadata: this.assetMetadata(uploaded, sourceHash) };
  }

  private assetMetadata(asset: { id: string; imageUrl: string; uploadedAt: string }, sourceHash: string): UgcPreparedReference["metadata"] {
    return {
      kreaAssetProvider: KREA_UGC_PROVIDER, kreaAssetVersion: 1, kreaAssetHash: sourceHash,
      kreaAssetId: asset.id, kreaAssetUrl: asset.imageUrl, kreaAssetUploadedAt: asset.uploadedAt,
    };
  }

  async submit(request: UgcReferenceRequest, prepared?: UgcPreparedReference): Promise<ProviderJobRef> {
    const productUrl = prepared?.metadata.kreaAssetUrl;
    if (typeof productUrl !== "string") throw new ProviderError("Asset Krea não preparado; nenhum envio pago foi feito.");
    const body = buildKreaReferenceBody(request, productUrl);
    const { jobId, requestId } = await this.http.createJob(KREA_REFERENCE_ENDPOINT, { ...body }, [request.prompt]);
    return { providerJobId: `krea:${jobId}`, ...(requestId ? { requestId } : {}) };
  }

  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    const { jobId } = parseKreaJobRef(ref.providerJobId);
    return status(this.http, ref.providerJobId, await this.http.getJob(jobId));
  }

  async downloadResult(ref: ProviderJobRef): Promise<UgcImageResult> {
    const { jobId } = parseKreaJobRef(ref.providerJobId);
    const data = await this.http.download(await completedUrl(this.http, jobId, { generations: 1 }), jobId, "image");
    const mimeType = detectImageType(data);
    const size = mimeType ? imageDimensions(data, mimeType) : undefined;
    // Job concluído (cobrado) mas arquivo inválido: custo registrado, sem retry.
    if (!mimeType || !size) throw this.http.error({ kind: "invalid_response", billing: "unconfirmed" }, "failed_after_job", jobId, { generations: 1 });
    return { uri: "", data, mimeType, width: size.width, height: size.height, billedUsage: { generations: 1 }, isMock: false, metadata: { kreaJobId: jobId } };
  }
}

/** Veo 3.1 (Fast/Standard) via Krea com áudio nativo; start_image = referência aprovada. */
export class UgcVideoProviderKrea implements UgcVideoProvider {
  readonly descriptor;
  readonly audioStrategy = "native_speech" as const;
  readonly modelConfig: KreaVeoConfig;
  readonly capabilities = { supportsReferenceImages: false, maxReferenceImages: 0, supportsSeed: false, nativeAudio: true };

  constructor(private readonly pricing: ProviderPricing, private readonly http: KreaHttpClient, private readonly loadImage: KreaImageLoader) {
    if (pricing.provider !== KREA_UGC_PROVIDER) throw new ProviderError("Preço não pertence à Krea.");
    this.modelConfig = kreaVeoConfigForPricingModel(pricing.model);
    this.descriptor = { id: KREA_UGC_PROVIDER, model: this.modelConfig.model, isMock: false, pricing };
  }

  estimateCost(seconds: number) {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { seconds: kreaRequestedDuration(seconds) }), pricing: this.pricing };
  }

  async prepare(request: UgcVideoRequest, previous?: Record<string, string | number | boolean>): Promise<UgcPreparedReference> {
    buildKreaVeoBody(request, this.modelConfig, "https://placeholder.invalid/");
    const image = await this.loadImage(request.reference.imageUri);
    const sourceHash = createHash("sha256").update(image.data).digest("hex");
    const priorId = previous?.kreaAssetId;
    if (previous?.kreaAssetHash === sourceHash && previous?.kreaAssetProvider === KREA_UGC_PROVIDER && previous?.kreaAssetVersion === 1 && typeof priorId === "string") {
      const current = await this.http.getAsset(priorId);
      if (current) return { metadata: { kreaAssetProvider: KREA_UGC_PROVIDER, kreaAssetVersion: 1, kreaAssetHash: sourceHash,
        kreaAssetId: current.id, kreaAssetUrl: current.imageUrl, kreaAssetUploadedAt: current.uploadedAt } };
    }
    const asset = await this.http.uploadAsset(image.data, image.mimeType, "reference");
    return { metadata: { kreaAssetProvider: KREA_UGC_PROVIDER, kreaAssetVersion: 1, kreaAssetHash: sourceHash,
      kreaAssetId: asset.id, kreaAssetUrl: asset.imageUrl, kreaAssetUploadedAt: asset.uploadedAt } };
  }

  async submit(request: UgcVideoRequest, prepared?: UgcPreparedReference): Promise<ProviderJobRef> {
    const startUrl = prepared?.metadata.kreaAssetUrl;
    if (typeof startUrl !== "string") throw new ProviderError("Asset Krea não preparado; nenhum envio pago foi feito.");
    const body = buildKreaVeoBody(request, this.modelConfig, startUrl);
    const { jobId, requestId } = await this.http.createJob(this.modelConfig.endpoint, { ...body }, [request.speech, request.action]);
    return { providerJobId: `krea:${jobId}:${body.duration}s`, ...(requestId ? { requestId } : {}) };
  }

  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    const { jobId } = parseKreaJobRef(ref.providerJobId);
    return status(this.http, ref.providerJobId, await this.http.getJob(jobId));
  }

  async downloadResult(ref: ProviderJobRef): Promise<UgcVideoResult> {
    const { jobId, seconds } = parseKreaJobRef(ref.providerJobId);
    const data = await this.http.download(await completedUrl(this.http, jobId, seconds ? { seconds } : {}), jobId, "video");
    const inspection = inspectMp4(data);
    return {
      uri: "", data, mimeType: "video/mp4", durationSeconds: inspection.durationSeconds ?? seconds ?? 0,
      ...(seconds ? { requestedDurationSeconds: seconds } : {}),
      billedUsage: seconds ? { seconds } : {}, isMock: false, hasAudio: inspection.hasAudioTrack,
    };
  }
}
