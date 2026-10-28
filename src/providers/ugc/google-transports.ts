import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { detectImageType } from "@/domain/upload";
import { AssetResolver } from "@/render/asset-resolver";
import { imageDimensions } from "@/render/image-dimensions";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import { inspectMp4 } from "../video/mp4";
import { ProviderError, type ProviderJobRef, type ProviderJobStatus } from "../types";
import type { GoogleImageGenerationRequest, VeoGenerateRequest } from "./google-ugc-contract";
import type { GoogleUgcReferenceTransport, VeoUgcVideoTransport } from "./google-ugc-providers";
import type { GoogleAiHttpClient } from "./google-http";
import type { UgcImageResult, UgcVideoResult } from "./ugc-providers";

/** Limite por imagem enviada inline (a requisição inteira da Gemini API aceita até ~20 MB). */
export const GOOGLE_MAX_INLINE_IMAGE_BYTES = 7 * 1024 * 1024;

export type GoogleImageLoader = (uri: string) => Promise<{ data: Uint8Array; mimeType: string }>;

/** Lê imagem LOCAL autorizada (uploads/UGC) e valida assinatura antes de qualquer rede. */
export function localImageLoader(roots: readonly string[]): GoogleImageLoader {
  const resolver = new AssetResolver(roots);
  return async (uri) => {
    const asset = await resolver.resolve(uri);
    if (asset.kind !== "file" || asset.media !== "image") throw new ProviderError("AI UGC Google exige imagem local válida.");
    const data = new Uint8Array(await readFile(asset.absolutePath));
    const mimeType = detectImageType(data);
    if (!mimeType) throw new ProviderError("AI UGC Google: arquivo de imagem inválido.");
    if (data.byteLength > GOOGLE_MAX_INLINE_IMAGE_BYTES) throw new ProviderError("AI UGC Google: imagem passa de 7 MB; reduza a foto.");
    return { data, mimeType };
  };
}

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const created = (kind: ProviderDiagnostic["kind"], extra: Partial<ProviderDiagnostic> = {}): ProviderDiagnostic => ({ kind, billing: "unconfirmed", operation: "created", ...extra });

/**
 * Gemini image generation (`generateContent`, síncrono). O "operation ID" é o responseId; o
 * resultado fica em memória até o pipeline persistir. Reinício entre a resposta e a persistência
 * vira falha COBRADA (custo registrado), nunca novo envio.
 */
export class GeminiReferenceTransport implements GoogleUgcReferenceTransport {
  private readonly results = new Map<string, UgcImageResult>();
  constructor(private readonly http: GoogleAiHttpClient, private readonly loadImage: GoogleImageLoader) {}

  async submit(request: GoogleImageGenerationRequest): Promise<ProviderJobRef> {
    const product = await this.loadImage(request.input[1].sourceUri);
    const { body, requestId } = await this.http.json("POST", `models/${request.model}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: request.input[0].text }, { inlineData: { mimeType: product.mimeType, data: b64(product.data) } }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: request.responseFormat.aspectRatio, imageSize: request.responseFormat.imageSize } },
    });
    const id = typeof body.responseId === "string" && /^[\w.-]{1,200}$/.test(body.responseId) ? `gemini/${body.responseId}` : `gemini/local-${randomUUID()}`;
    const candidates = Array.isArray(body.candidates) ? body.candidates as Record<string, unknown>[] : [];
    const parts = candidates.flatMap(c => {
      const content = c.content as { parts?: unknown } | undefined;
      return Array.isArray(content?.parts) ? content.parts as Record<string, unknown>[] : [];
    });
    const inline = parts.map(p => (p.inlineData ?? p.inline_data) as { mimeType?: string; mime_type?: string; data?: string } | undefined).find(p => typeof p?.data === "string");
    const usage = (body.usageMetadata ?? {}) as Record<string, unknown>;
    const tokens = (key: string) => (typeof usage[key] === "number" ? usage[key] as number : undefined);
    const metadata = {
      ...(tokens("promptTokenCount") === undefined ? {} : { promptTokens: tokens("promptTokenCount")! }),
      ...(tokens("candidatesTokenCount") === undefined ? {} : { outputTokens: tokens("candidatesTokenCount")! }),
      ...(typeof body.modelVersion === "string" ? { modelVersion: this.http.clean(body.modelVersion) ?? "" } : {}),
    };
    if (!inline?.data) {
      const reason = this.http.clean(candidates[0]?.finishReason ?? (body.promptFeedback as Record<string, unknown> | undefined)?.blockReason);
      // Resposta 200 sem imagem (ex.: filtro de segurança): houve chamada; não reenviar.
      throw this.http.error(created("provider", { requestId, providerCode: reason ?? "NO_IMAGE", httpStatus: 200 }), "failed_after_operation", id);
    }
    const data = new Uint8Array(Buffer.from(inline.data, "base64"));
    const mimeType = detectImageType(data);
    const size = mimeType ? imageDimensions(data, mimeType) : undefined;
    // Imagem produzida (cobrada) mas inválida: custo registrado, sem retry.
    if (!mimeType || !size) throw this.http.error(created("invalid_response", { requestId, httpStatus: 200 }), "failed_after_operation", id, { generations: 1 });
    this.results.set(id, { uri: "", data, mimeType, width: size.width, height: size.height, billedUsage: { generations: 1 }, isMock: false, requestId, metadata });
    return { providerJobId: id };
  }

  async poll(operationId: string): Promise<ProviderJobStatus> {
    if (this.results.has(operationId)) return { providerJobId: operationId, state: "succeeded" };
    throw this.http.error(created("invalid_response"), "failed_after_operation", operationId, { generations: 1 });
  }

  async download(operationId: string): Promise<UgcImageResult> {
    const result = this.results.get(operationId);
    if (!result) throw this.http.error(created("invalid_response"), "failed_after_operation", operationId, { generations: 1 });
    this.results.delete(operationId);
    return result;
  }
}

const OPERATION_NAME = /^(models\/[\w.-]+\/)?operations\/[\w.-]{1,200}$/;

/**
 * Veo 3.1 (`predictLongRunning`): submit → operation name → polling GET → download do MP4.
 * Sem estado necessário entre reinícios: o operation ID persistido basta para retomar.
 */
export class VeoVideoTransport implements VeoUgcVideoTransport {
  private readonly videos = new Map<string, string>();
  private readonly requested = new Map<string, number>();
  constructor(private readonly http: GoogleAiHttpClient, private readonly loadImage: GoogleImageLoader) {}

  async submit(request: VeoGenerateRequest): Promise<ProviderJobRef> {
    // Toda leitura/validação local acontece ANTES da rede.
    const image = await this.loadImage(request.image.sourceUri);
    const references = await Promise.all((request.config.referenceImages ?? []).map(async ref => ({ ref, file: await this.loadImage(ref.image.sourceUri) })));
    const { body, requestId } = await this.http.json("POST", `models/${request.model}:predictLongRunning`, {
      instances: [{
        prompt: request.prompt,
        image: { inlineData: { mimeType: image.mimeType, data: b64(image.data) } },
        ...(references.length ? { referenceImages: references.map(({ ref, file }) => ({ image: { inlineData: { mimeType: file.mimeType, data: b64(file.data) } }, referenceType: ref.referenceType })) } : {}),
      }],
      parameters: {
        aspectRatio: request.config.aspectRatio,
        resolution: request.config.resolution,
        durationSeconds: Number(request.config.durationSeconds),
        personGeneration: request.config.personGeneration,
        sampleCount: request.config.numberOfVideos,
        ...(request.config.seed === undefined ? {} : { seed: request.config.seed }),
      },
    });
    const name = body.name;
    // 200 sem operation name: pode ter sido aceito → incerto, sem reenvio.
    if (typeof name !== "string" || !OPERATION_NAME.test(name)) throw this.http.error({ kind: "invalid_response", httpStatus: 200, requestId, billing: "unconfirmed" }, "uncertain");
    this.requested.set(name, request.metadata.requestedDurationSeconds);
    return { providerJobId: name };
  }

  async poll(operationId: string): Promise<ProviderJobStatus> {
    if (!OPERATION_NAME.test(operationId)) throw new ProviderError("Operation ID Veo inválido.");
    const { body, requestId } = await this.http.json("GET", operationId, undefined, operationId);
    if (body.done !== true) return { providerJobId: operationId, state: "running" };
    const error = body.error as Record<string, unknown> | undefined;
    if (error) {
      return { providerJobId: operationId, state: "failed", error: this.http.error(created("provider", { requestId, providerCode: this.http.clean(error.status ?? error.code), providerMessage: this.http.clean(error.message) }), "failed_after_operation", operationId).message,
        diagnostic: created("provider", { requestId, providerCode: this.http.clean(error.status ?? error.code) }) };
    }
    const response = (body.response ?? {}) as Record<string, unknown>;
    const generated = (response.generateVideoResponse ?? response) as Record<string, unknown>;
    const samples = Array.isArray(generated.generatedSamples) ? generated.generatedSamples as Record<string, unknown>[] : Array.isArray(generated.generatedVideos) ? generated.generatedVideos as Record<string, unknown>[] : [];
    const uri = (samples[0]?.video as { uri?: unknown } | undefined)?.uri;
    if (typeof uri !== "string") {
      const filtered = this.http.clean(generated.raiMediaFilteredReasons ?? generated.raiMediaFilteredCount);
      return { providerJobId: operationId, state: "failed", error: this.http.error(created("provider", { requestId, providerCode: filtered ?? "NO_VIDEO" }), "failed_after_operation", operationId).message,
        diagnostic: created("provider", { requestId, providerCode: filtered ?? "NO_VIDEO" }) };
    }
    this.videos.set(operationId, uri);
    return { providerJobId: operationId, state: "succeeded" };
  }

  async download(operationId: string): Promise<UgcVideoResult> {
    if (!this.videos.has(operationId)) await this.poll(operationId);
    const uri = this.videos.get(operationId);
    if (!uri) throw this.http.error(created("invalid_response"), "uncertain", operationId);
    const data = await this.http.download(uri, operationId);
    const requested = this.requested.get(operationId);
    const inspection = inspectMp4(data);
    // Cobrança por segundo gerado: sem duração conhecida aqui, o pipeline usa a duração persistida na intenção.
    return {
      uri: "", data, mimeType: "video/mp4", durationSeconds: inspection.durationSeconds ?? requested ?? 0,
      ...(requested ? { requestedDurationSeconds: requested } : {}),
      billedUsage: requested ? { seconds: requested } : {}, isMock: false, hasAudio: inspection.hasAudioTrack,
    };
  }
}
