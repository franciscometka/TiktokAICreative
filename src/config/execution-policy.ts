import type { AppConfig } from "./env";

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionStage } from "@/domain/execution";
const authorization = new AsyncLocalStorage<{ stage: ExecutionStage; remaining: number }>();
/** Uma chamada paga por ação aprovada; polling não consome uma nova autorização. */
export function withRealStageAuthorization<T>(stage: ExecutionStage, run: () => Promise<T>): Promise<T> {
  return authorization.run({ stage, remaining: 1 }, run);
}
export function assertRealCallsEnabled(paid = true): void {
  const permit = authorization.getStore();
  if (!permit || (paid && permit.remaining < 1)) throw new Error("Chamadas reais/pagas bloqueadas. Exigem aprovação explícita da etapa; --confirm isolado não desbloqueia essa proteção.");
  if (paid) permit.remaining--;
}
export function offlineConfig(config: AppConfig): AppConfig {
  return { ...config, llmProvider: "mock", videoProvider: "mock", audioProvider: "mock", storage: "file",
    mockPlannerDelayMs: config.mockPlannerDelayMs || 500, renderer: { ...config.renderer, id: "mock" }, ugc: { ...config.ugc, realAllowed: false } };
}
