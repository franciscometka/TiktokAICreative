import { costForUsage, ugcVideoUsage } from "@/costs/calculate";
import type { ProviderPricing } from "@/domain/cost";
import type { UgcAudioStrategy } from "@/domain/ugc";
import { ProviderError, type ProviderJobRef } from "../types";
import type {
  UgcImageResult,
  UgcReferenceProvider,
  UgcReferenceRequest,
  UgcVideoProvider,
  UgcVideoRequest,
  UgcVideoResult,
} from "./ugc-providers";

/**
 * Mocks do AI UGC: nenhuma rede, nenhum arquivo, custo SIMULADO pelo preço do tier. Guardam as
 * chamadas para os testes provarem consistência (mesma referência/identidade/produto) e que nada é
 * gerado antes da aprovação. URIs mock:// — a interface mostra "MOCK" e nunca finge ser real.
 */

export class MockUgcReferenceProvider implements UgcReferenceProvider {
  readonly descriptor;
  readonly calls: UgcReferenceRequest[] = [];
  private readonly jobs = new Map<string, UgcReferenceRequest>();

  constructor(private readonly pricing: ProviderPricing, private readonly options: { fail?: boolean } = {}) {
    this.descriptor = { id: "mock", model: pricing.model, isMock: true, pricing };
  }

  estimateCost() {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { generations: 1 }), pricing: this.pricing };
  }

  async submit(request: UgcReferenceRequest): Promise<ProviderJobRef> {
    this.calls.push(request);
    const providerJobId = `mockugcref_${this.calls.length}`;
    this.jobs.set(providerJobId, request);
    return { providerJobId };
  }

  async getStatus(ref: ProviderJobRef) {
    if (!this.jobs.has(ref.providerJobId)) throw new ProviderError("Tarefa de referência desconhecida", ref.providerJobId);
    return this.options.fail
      ? { providerJobId: ref.providerJobId, state: "failed" as const, error: "[MOCK] falha simulada da referência" }
      : { providerJobId: ref.providerJobId, state: "succeeded" as const };
  }

  async downloadResult(ref: ProviderJobRef): Promise<UgcImageResult> {
    if (!this.jobs.has(ref.providerJobId)) throw new ProviderError("Resultado indisponível", ref.providerJobId);
    return { uri: `mock://ugc-reference/${ref.providerJobId}.png`, mimeType: "image/png", width: 720, height: 1280, billedUsage: { generations: 1 }, isMock: true };
  }
}

export class MockUgcVideoProvider implements UgcVideoProvider {
  readonly descriptor;
  readonly calls: UgcVideoRequest[] = [];
  private readonly jobs = new Map<string, UgcVideoRequest>();

  constructor(
    private readonly pricing: ProviderPricing,
    readonly audioStrategy: UgcAudioStrategy = "native_speech",
    private readonly options: { fail?: boolean } = {},
  ) {
    this.descriptor = { id: "mock", model: pricing.model, isMock: true, pricing };
  }

  estimateCost(seconds: number) {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, ugcVideoUsage(seconds, this.pricing)), pricing: this.pricing };
  }

  async submit(request: UgcVideoRequest): Promise<ProviderJobRef> {
    if (!request.reference.imageUri) throw new ProviderError("Cena UGC sem referência aprovada");
    if (this.audioStrategy === "external_lipsync" && !request.audio) throw new ProviderError("Lip sync exige o trecho da narração");
    this.calls.push(request);
    const providerJobId = `mockugcvid_${this.calls.length}`;
    this.jobs.set(providerJobId, request);
    return { providerJobId };
  }

  async getStatus(ref: ProviderJobRef) {
    if (!this.jobs.has(ref.providerJobId)) throw new ProviderError("Tarefa de vídeo UGC desconhecida", ref.providerJobId);
    return this.options.fail
      ? { providerJobId: ref.providerJobId, state: "failed" as const, error: "[MOCK] falha simulada da cena UGC" }
      : { providerJobId: ref.providerJobId, state: "succeeded" as const };
  }

  async downloadResult(ref: ProviderJobRef): Promise<UgcVideoResult> {
    const request = this.jobs.get(ref.providerJobId);
    if (!request) throw new ProviderError("Resultado indisponível", ref.providerJobId);
    return {
      uri: `mock://ugc-video/${request.sceneId}/${ref.providerJobId}.mp4`,
      mimeType: "video/mp4",
      durationSeconds: request.durationSeconds,
      billedUsage: { seconds: request.durationSeconds, generations: 1 },
      isMock: true,
      hasAudio: this.audioStrategy === "native_speech",
      requestedDurationSeconds: request.durationSeconds,
    };
  }
}
