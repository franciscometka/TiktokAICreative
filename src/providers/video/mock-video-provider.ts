import { costForUsage, type Usage } from "@/costs/calculate";
import type { ProviderPricing } from "@/domain/cost";
import {
  ProviderError,
  type CostQuote,
  type MediaResult,
  type ProviderDescriptor,
  type ProviderJobRef,
  type ProviderJobStatus,
} from "../types";
import type { VideoGenerationRequest, VideoProvider } from "./video-provider";

export interface MockVideoProviderOptions {
  /** Preço que o mock SIMULA (do tier planejado), para exercitar orçamento sem gastar. */
  pricing: ProviderPricing;
  /** Quantas consultas de status até concluir (default 1). */
  pollsUntilComplete?: number;
  /** Cenas que falharão (para testar falhas). */
  failSceneIds?: ReadonlySet<string>;
  /** Fatura simulada em falha (ex.: provider que cobra tentativas falhas). */
  billFailures?: boolean;
  /** Multiplicador sobre os segundos faturados (simula provider cobrando acima do estimado). */
  billingMultiplier?: number;
}

interface MockJob {
  request: VideoGenerationRequest;
  polls: number;
  willFail: boolean;
}

/**
 * Provider de vídeo FALSO. Não chama nenhuma API, não gera arquivo de vídeo.
 * Retorna URIs "mock://" e custo SIMULADO (descriptor.isMock = true).
 */
export class MockVideoProvider implements VideoProvider {
  readonly descriptor: ProviderDescriptor;
  /** Histórico de generateScene — testes usam para provar que nada foi chamado antes da aprovação. */
  readonly generateCalls: VideoGenerationRequest[] = [];
  private readonly jobs = new Map<string, MockJob>();
  private readonly pollsUntilComplete: number;
  private readonly failSceneIds: ReadonlySet<string>;
  private readonly billFailures: boolean;
  private readonly billingMultiplier: number;

  constructor(private readonly options: MockVideoProviderOptions) {
    this.pollsUntilComplete = options.pollsUntilComplete ?? 1;
    this.failSceneIds = options.failSceneIds ?? new Set();
    this.billFailures = options.billFailures ?? false;
    this.billingMultiplier = options.billingMultiplier ?? 1;
    this.descriptor = { id: "mock", model: options.pricing.model, isMock: true, pricing: options.pricing };
  }

  estimateCost(request: VideoGenerationRequest): CostQuote {
    const { quantity, costUsd } = costForUsage(this.options.pricing, {
      seconds: request.durationSeconds,
      generations: 1,
    });
    return { kind: "estimate", quantity, costUsd, pricing: this.options.pricing };
  }

  async generateScene(request: VideoGenerationRequest): Promise<ProviderJobRef> {
    if (!(request.durationSeconds > 0)) throw new ProviderError("durationSeconds deve ser > 0");
    if (request.prompt.trim() === "") throw new ProviderError("prompt vazio");
    this.generateCalls.push(request);
    const providerJobId = `mockvid_${this.generateCalls.length}`;
    this.jobs.set(providerJobId, {
      request,
      polls: 0,
      willFail: this.failSceneIds.has(request.sceneId),
    });
    return { providerJobId };
  }

  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    const job = this.requireJob(ref);
    job.polls += 1;
    if (job.polls < this.pollsUntilComplete) {
      return { providerJobId: ref.providerJobId, state: "running" };
    }
    if (job.willFail) {
      return {
        providerJobId: ref.providerJobId,
        state: "failed",
        error: "[MOCK] falha simulada",
        billedUsage: this.billFailures ? this.billed(job) : undefined,
      };
    }
    return { providerJobId: ref.providerJobId, state: "succeeded" };
  }

  async downloadResult(ref: ProviderJobRef): Promise<MediaResult> {
    const job = this.requireJob(ref);
    if (job.willFail || job.polls < this.pollsUntilComplete) {
      throw new ProviderError("Resultado indisponível", ref.providerJobId);
    }
    return {
      uri: `mock://video/${ref.providerJobId}.mp4`,
      mimeType: "video/mp4",
      durationSeconds: job.request.durationSeconds,
      billedUsage: this.billed(job),
      isMock: true,
    };
  }

  private billed(job: MockJob): Usage {
    return { seconds: job.request.durationSeconds * this.billingMultiplier, generations: 1 };
  }

  private requireJob(ref: ProviderJobRef): MockJob {
    const job = this.jobs.get(ref.providerJobId);
    if (!job) throw new ProviderError("Job desconhecido", ref.providerJobId);
    return job;
  }
}
