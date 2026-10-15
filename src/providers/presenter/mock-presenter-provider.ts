import { randomUUID } from "node:crypto";
import type { ProviderPricing } from "@/domain/cost";
import { presenterBilledSeconds } from "@/config/presenters";
import { costForUsage } from "@/costs/calculate";
import type { PresenterProvider, PresenterRequest, PresenterRef } from "./presenter-provider";

/** Stateless simulation, resumable from a persisted reference without audio bytes or network. */
export class MockPresenterProvider implements PresenterProvider {
  readonly descriptor;
  constructor(private readonly pricing: ProviderPricing) {
    this.descriptor = { id: "mock", model: pricing.model, isMock: true, pricing };
  }
  estimateCost(seconds: number) {
    return { kind: "estimate" as const, ...costForUsage(this.pricing, { seconds: presenterBilledSeconds(seconds) }), pricing: this.pricing };
  }
  async submit(request: PresenterRequest): Promise<PresenterRef> {
    presenterBilledSeconds(request.durationSeconds);
    return { providerJobId: `mockavatar_${randomUUID()}`, requestedDurationSeconds: request.durationSeconds };
  }
  async getStatus(ref: PresenterRef) {
    if (!ref.providerJobId.startsWith("mockavatar_")) throw new Error("Tarefa real não pode ser retomada pelo simulador.");
    return { providerJobId: ref.providerJobId, state: "succeeded" as const };
  }
  async downloadResult(ref: PresenterRef) {
    await this.getStatus(ref);
    return { uri: `mock://presenter/${ref.providerJobId}.mp4`, mimeType: "video/mp4", durationSeconds: ref.requestedDurationSeconds,
      billedUsage: { seconds: presenterBilledSeconds(ref.requestedDurationSeconds) }, isMock: true };
  }
}
