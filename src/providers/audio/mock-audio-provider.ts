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
import type { AudioGenerationRequest, AudioProvider } from "./audio-provider";

export interface MockAudioProviderOptions {
  pricing: ProviderPricing;
  /** Velocidade de fala simulada para calcular a duração do áudio. */
  charsPerSecond?: number;
  fail?: boolean;
}

/** Provider de áudio FALSO. Não sintetiza voz. Retorna URI "mock://" e custo SIMULADO. */
export class MockAudioProvider implements AudioProvider {
  readonly descriptor: ProviderDescriptor;
  readonly generateCalls: AudioGenerationRequest[] = [];
  private readonly jobs = new Map<string, AudioGenerationRequest>();
  private readonly charsPerSecond: number;

  constructor(private readonly options: MockAudioProviderOptions) {
    this.charsPerSecond = options.charsPerSecond ?? 15;
    this.descriptor = { id: "mock", model: options.pricing.model, isMock: true, pricing: options.pricing };
  }

  estimateCost(request: AudioGenerationRequest): CostQuote {
    const { quantity, costUsd } = costForUsage(this.options.pricing, this.usage(request));
    return { kind: "estimate", quantity, costUsd, pricing: this.options.pricing };
  }

  async generateAudio(request: AudioGenerationRequest): Promise<ProviderJobRef> {
    if (request.text.trim() === "") throw new ProviderError("texto vazio");
    this.generateCalls.push(request);
    const providerJobId = `mockaud_${this.generateCalls.length}`;
    this.jobs.set(providerJobId, request);
    return { providerJobId };
  }

  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    this.requireJob(ref);
    return this.options.fail
      ? { providerJobId: ref.providerJobId, state: "failed", error: "[MOCK] falha simulada" }
      : { providerJobId: ref.providerJobId, state: "succeeded" };
  }

  async downloadResult(ref: ProviderJobRef): Promise<MediaResult> {
    const request = this.requireJob(ref);
    if (this.options.fail) throw new ProviderError("Resultado indisponível", ref.providerJobId);
    return {
      uri: `mock://audio/${ref.providerJobId}.mp3`,
      mimeType: "audio/mpeg",
      durationSeconds: this.durationOf(request),
      billedUsage: this.usage(request),
      isMock: true,
    };
  }

  private durationOf(request: AudioGenerationRequest): number {
    return Math.round((request.text.length / this.charsPerSecond) * 10) / 10;
  }

  private usage(request: AudioGenerationRequest): Usage {
    return { characters: request.text.length, seconds: this.durationOf(request), generations: 1 };
  }

  private requireJob(ref: ProviderJobRef): AudioGenerationRequest {
    const job = this.jobs.get(ref.providerJobId);
    if (!job) throw new ProviderError("Job desconhecido", ref.providerJobId);
    return job;
  }
}
