import type { AppConfig } from "@/config/env";
import { readAnthropicApiKey, readElevenLabsApiKey, readRunwayApiKey, readRemotionLicenseKey } from "@/config/env";
import { createAnthropicLlmClient } from "@/ai/create-llm-client";
import { LlmCreativePlanner } from "@/ai/llm-planner";
import { MockCreativePlanner } from "@/ai/mock-planner";
import { randomId } from "@/lib/ids";
import { createVideoProviderFactory } from "@/providers/video";
import { createAudioProviderFactory } from "@/providers/audio";
import { MockPresenterProvider } from "@/providers/presenter/mock-presenter-provider";
import { RunwayPresenterProvider } from "@/providers/presenter/runway-presenter-provider";
import { createRenderer } from "@/render/create-renderer";
import type { StageCapabilities } from "@/domain/execution";
import { detectRemotionBrowser } from "@/render/remotion/browser-readiness";
import { createOfflinePipelineService, VersionedMockRenderer } from "./offline-service";
import type { PipelineDeps } from "./pipeline-service";

export function hybridCapabilities(config: AppConfig, env: Record<string, string | undefined> = process.env): StageCapabilities {
  const available = (ok: boolean, provider: string, reason: string) => ({ available: ok, provider, reason: ok ? undefined : reason });
  const browser = detectRemotionBrowser(config.renderer.browserExecutable);
  return {
    planning: available(config.llmProvider === "anthropic" && !!readAnthropicApiKey(env), "anthropic", "Configure LLM_PROVIDER=anthropic e ANTHROPIC_API_KEY no servidor."),
    narration: available(config.audioProvider === "elevenlabs" && !!readElevenLabsApiKey(env), "elevenlabs", "Configure AUDIO_PROVIDER=elevenlabs e ELEVENLABS_API_KEY no servidor."),
    scenes: available(config.videoProvider === "runway" && !!readRunwayApiKey(env), "runway", "Configure VIDEO_PROVIDER=runway e RUNWAYML_API_SECRET no servidor."),
    avatar: available(!!readRunwayApiKey(env), "runway", "Configure RUNWAYML_API_SECRET no servidor. Avatar real exige também narração real com alignment."),
    // AI UGC real: contrato Google/Veo preparado, mas sem transporte nesta implementação.
    ugc_reference: available(false, "google", "Provider AI UGC real ainda não configurado: contrato Google/Veo preparado, sem chamadas nesta versão."),
    ugc_video: available(false, "google", "Provider AI UGC real ainda não configurado: contrato Google/Veo preparado, sem chamadas nesta versão."),
    render: available(config.renderer.id === "remotion" && browser.available, "remotion", config.renderer.id !== "remotion" ? "Configure RENDERER=remotion no servidor." : browser.detail),
  };
}
/** Defaults sempre MOCK. As implementações reais só são instanciadas na etapa selecionada. */
export function createHybridPipelineService(config: AppConfig, overrides: Partial<PipelineDeps> = {}, env: Record<string, string | undefined> = process.env) {
  const ids = overrides.ids ?? randomId;
  const mockPlanner = new MockCreativePlanner(ids, config.mockPlannerDelayMs);
  const mockRenderer = new VersionedMockRenderer();
  const renderer = createRenderer("remotion", { rendersDir: config.rendersDir, allowedAssetRoots: [config.uploadsDir, config.audioDir, config.videosDir, config.ugcDir], concurrency: config.renderer.concurrency, debug: config.renderer.debug, browserExecutable: config.renderer.browserExecutable, licenseKey: readRemotionLicenseKey(env) });
  const hybrid: NonNullable<PipelineDeps["hybrid"]> = {
    capabilities: hybridCapabilities(config, env),
    planner: mode => mode === "mock" ? mockPlanner : new LlmCreativePlanner(createAnthropicLlmClient({ llmPolicy: { ...config.llmPolicy, maxTransportRetries: 0 } }, env), ids, { maxValidationAttempts: 1 }),
    audio: (pricing, mode) => createAudioProviderFactory(mode === "real" ? "elevenlabs" : "mock", { elevenLabsApiKey: readElevenLabsApiKey(env), ttsTimeoutMs: config.ttsTimeoutMs })(pricing),
    video: (pricing, mode) => createVideoProviderFactory(mode === "real" ? "runway" : "mock", { apiKey: readRunwayApiKey(env), uploadsDir: config.uploadsDir })(pricing),
    presenter: (pricing, mode) => mode === "real" ? new RunwayPresenterProvider({ pricing, apiKey: readRunwayApiKey(env) ?? "" }) : new MockPresenterProvider(pricing),
    renderer: mode => mode === "real" ? renderer : mockRenderer,
  };
  // A fábrica offline mantém o storage local e os defaults; o serviço híbrido faz o roteamento.
  return createOfflinePipelineService(config, { ...overrides, hybrid: overrides.hybrid ?? hybrid, ids });
}
