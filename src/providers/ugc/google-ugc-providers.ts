import { costForUsage } from "@/costs/calculate";
import { veoConfigForPricingModel, veoRequestedDuration, type VeoModelConfig } from "@/config/ugc-models";
import type { ProviderPricing } from "@/domain/cost";
import type { ProviderJobRef, ProviderJobStatus } from "../types";
import { buildGoogleUgcReferenceRequest, buildVeoUgcVideoRequest, type GoogleImageGenerationRequest, type VeoGenerateRequest } from "./google-ugc-contract";
import type { UgcImageResult, UgcReferenceProvider, UgcReferenceRequest, UgcVideoProvider, UgcVideoRequest, UgcVideoResult } from "./ugc-providers";

/** Contratos dos transportes futuros. Nenhuma implementação de rede existe neste lote. */
export interface GoogleUgcReferenceTransport {
  submit(request: GoogleImageGenerationRequest): Promise<ProviderJobRef>;
  poll(operationId: string): Promise<ProviderJobStatus>;
  download(operationId: string): Promise<UgcImageResult>;
}

export interface VeoUgcVideoTransport {
  submit(request: VeoGenerateRequest): Promise<ProviderJobRef>;
  poll(operationId: string): Promise<ProviderJobStatus>;
  download(operationId: string): Promise<UgcVideoResult>;
}

/** Adapter futuro Nano Banana; polling/timeout e retomada por operation ID permanecem no pipeline. */
export class UgcReferenceProviderGoogle implements UgcReferenceProvider {
  readonly descriptor;
  /** O transporte Gemini atual envia só a foto do produto: avatar salvo com foto é bloqueado. */
  readonly supportsIdentityReference = false;

  constructor(private readonly pricing: ProviderPricing, private readonly transport: GoogleUgcReferenceTransport) {
    this.descriptor = { id: "google", model: pricing.model, isMock: false, pricing };
  }

  estimateCost() {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { generations: 1 }), pricing: this.pricing };
  }

  submit(request: UgcReferenceRequest) { return this.transport.submit(buildGoogleUgcReferenceRequest(request)); }
  getStatus(ref: ProviderJobRef) { return this.transport.poll(ref.providerJobId); }
  downloadResult(ref: ProviderJobRef) { return this.transport.download(ref.providerJobId); }
}

/** Adapter futuro Veo 3.1; áudio nativo é obrigatório e não há fallback/retry automático. */
export class UgcVideoProviderVeo implements UgcVideoProvider {
  readonly descriptor;
  readonly audioStrategy = "native_speech" as const;
  readonly modelConfig: VeoModelConfig;
  readonly capabilities;

  constructor(private readonly pricing: ProviderPricing, private readonly transport: VeoUgcVideoTransport) {
    this.modelConfig = veoConfigForPricingModel(pricing.model);
    this.capabilities = { supportsReferenceImages: this.modelConfig.supportsReferenceImages, maxReferenceImages: 3, supportsSeed: true, nativeAudio: true };
    this.descriptor = { id: "google", model: this.modelConfig.model, isMock: false, pricing };
  }

  estimateCost(seconds: number) {
    const references = this.modelConfig.supportsReferenceImages ? 1 : 0;
    const requested = veoRequestedDuration(seconds, this.modelConfig, references);
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { seconds: requested }), pricing: this.pricing };
  }

  submit(request: UgcVideoRequest) { return this.transport.submit(buildVeoUgcVideoRequest(request, this.modelConfig)); }
  getStatus(ref: ProviderJobRef) { return this.transport.poll(ref.providerJobId); }
  downloadResult(ref: ProviderJobRef) { return this.transport.download(ref.providerJobId); }
}
