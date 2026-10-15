import type { AppConfig } from "./env";

/** Temporary product lock. Neither environment values nor a confirm flag unlock paid calls. */
export const REAL_CALLS_BLOCKED = true;
export function assertRealCallsEnabled(): void {
  if (REAL_CALLS_BLOCKED) throw new Error("Chamadas reais/pagas bloqueadas. O sistema está em modo offline; --confirm não desbloqueia essa proteção.");
}
export function offlineConfig(config: AppConfig): AppConfig {
  return { ...config, llmProvider: "mock", videoProvider: "mock", audioProvider: "mock", storage: "file",
    mockPlannerDelayMs: config.mockPlannerDelayMs || 500, renderer: { ...config.renderer, id: "mock" } };
}
