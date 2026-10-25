import type { AppConfig } from "./env";

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionStage } from "@/domain/execution";
const authorization = new AsyncLocalStorage<{ stage: ExecutionStage; remaining: number }>();
const executionFence = new AsyncLocalStorage<{ checkpoint: () => Promise<void> }>();
export class ExecutionLeaseLostError extends Error { override name = "ExecutionLeaseLostError"; }
/** Uma chamada paga por ação aprovada; polling não consome uma nova autorização. */
export function withRealStageAuthorization<T>(stage: ExecutionStage, run: () => Promise<T>): Promise<T> {
  return authorization.run({ stage, remaining: 1 }, run);
}
export function assertRealCallsEnabled(paid = true): void {
  const permit = authorization.getStore();
  if (!permit || (paid && permit.remaining < 1)) throw new Error("Chamadas reais/pagas bloqueadas. Exigem aprovação explícita da etapa; --confirm isolado não desbloqueia essa proteção.");
  if (paid) permit.remaining--;
}
/** Worker cloud: comprova que este claim ainda é o dono antes de um limite irreversível. */
export function withExecutionFence<T>(fence: { checkpoint: () => Promise<void> }, run: () => Promise<T>): Promise<T> {
  return executionFence.run(fence, run);
}
/** Local/testes sem fila não precisam de fence; dentro do worker a ausência de posse lança. */
export async function assertExecutionFence(): Promise<void> {
  await executionFence.getStore()?.checkpoint();
}
let mocksForcedForTests: boolean | undefined;
/** Só o setup do Vitest (e testes que verificam a política) usa isto. Nunca em runtime. */
export function forceMocksForTests(value: boolean | undefined): void { mocksForcedForTests = value; }
/** Política de MOCK do fluxo normal (Lote 5.5): ALLOW_MOCKS=true ou override explícito de teste. */
export function mocksAllowed(config: Pick<AppConfig, "allowMocks">): boolean { return mocksForcedForTests ?? config.allowMocks; }
export const MOCK_BLOCKED = "MOCK desabilitado (ALLOW_MOCKS=false): esta etapa precisa de provider REAL configurado.";

export function offlineConfig(config: AppConfig): AppConfig {
  return { ...config, llmProvider: "mock", videoProvider: "mock", audioProvider: "mock", storage: "file",
    mockPlannerDelayMs: config.mockPlannerDelayMs || 500, renderer: { ...config.renderer, id: "mock" }, ugc: { ...config.ugc, realAllowed: false } };
}
