import { googleUgcReadiness } from "@/config/ugc-readiness";
import { createUgcProviderFactories } from "@/providers/ugc";
import { googleUgcRuntime } from "@/providers/ugc/google-runtime";
import { kreaUgcRuntime } from "@/providers/ugc/krea-runtime";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import type { AppConfig, ConfigIssue } from "@/config/env";
import { mocksAllowed } from "@/config/execution-policy";
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

export function hybridCapabilities(config: AppConfig, env: Record<string, string | undefined> = process.env, issues: readonly ConfigIssue[] = [], projectRoot?: string): StageCapabilities {
  // Lote 5.5: configuração inválida NÃO cai em MOCK no fluxo normal; bloqueia todas as etapas.
  const invalid = !mocksAllowed(config) && issues.length > 0 ? `Configuração inválida: ${issues.map(issue => issue.variable).join(", ")}. Corrija .env.local; nenhuma geração até lá.` : undefined;
  const available = (ok: boolean, provider: string, reason: string) => invalid ? { available: false, provider, reason: invalid } : ({ available: ok, provider, reason: ok ? undefined : reason });
  const browser = detectRemotionBrowser(config.renderer.browserExecutable, projectRoot);
  const krea = config.ugc.provider === "krea";
  const ugc = krea ? kreaUgcReadiness(config, env) : googleUgcReadiness(config, env);
  return {
    planning: available(config.llmProvider === "anthropic" && !!readAnthropicApiKey(env), "anthropic", "Configure LLM_PROVIDER=anthropic e ANTHROPIC_API_KEY no servidor."),
    narration: available(config.audioProvider === "elevenlabs" && !!readElevenLabsApiKey(env), "elevenlabs", "Configure AUDIO_PROVIDER=elevenlabs e ELEVENLABS_API_KEY no servidor."),
    scenes: available(config.videoProvider === "runway" && !!readRunwayApiKey(env), "runway", "Configure VIDEO_PROVIDER=runway e RUNWAYML_API_SECRET no servidor."),
    avatar: available(!!readRunwayApiKey(env), "runway", "Configure RUNWAYML_API_SECRET no servidor. Avatar real exige também narração real com alignment."),
    // AI UGC real (Lote 5.4): só com preflight Google completo; a chave sozinha não habilita.
    ugc_reference: available(ugc.ready, krea ? "krea" : "google", ugc.reason ?? ""),
    ugc_video: available(ugc.ready, krea ? "krea" : "google", ugc.reason ?? ""),
    render: available(config.renderer.id === "remotion" && browser.available, "remotion", config.renderer.id !== "remotion" ? "Configure RENDERER=remotion no servidor." : browser.detail),
  };
}
/** Defaults sempre MOCK. As implementações reais só são instanciadas na etapa selecionada. */
/**
 * `roots` (Lote 7, worker): código do Remotion na raiz do app; assets relativos ao workspace
 * temporário do job (cwd da tarefa). Ausente = tudo relativo ao cwd, como no local.
 */
export function createHybridPipelineService(config: AppConfig, overrides: Partial<PipelineDeps> = {}, env: Record<string, string | undefined> = process.env, issues: readonly ConfigIssue[] = [], roots: { projectRoot?: string; assetRoot?: string } = {}) {
  const ids = overrides.ids ?? randomId;
  const mockPlanner = new MockCreativePlanner(ids, config.mockPlannerDelayMs);
  const mockRenderer = new VersionedMockRenderer();
  const renderer = createRenderer("remotion", { rendersDir: config.rendersDir, allowedAssetRoots: [config.uploadsDir, config.audioDir, config.videosDir, config.ugcDir], concurrency: config.renderer.concurrency, debug: config.renderer.debug, browserExecutable: config.renderer.browserExecutable, licenseKey: readRemotionLicenseKey(env), ...roots });
  const hybrid: NonNullable<PipelineDeps["hybrid"]> = {
    capabilities: hybridCapabilities(config, env, issues, roots.projectRoot),
    allowMocks: mocksAllowed(config),
    planner: mode => mode === "mock" ? mockPlanner : new LlmCreativePlanner(createAnthropicLlmClient({ llmPolicy: { ...config.llmPolicy, maxTransportRetries: 0 } }, env), ids, { maxValidationAttempts: 1 }),
    audio: (pricing, mode) => createAudioProviderFactory(mode === "real" ? "elevenlabs" : "mock", { elevenLabsApiKey: readElevenLabsApiKey(env), ttsTimeoutMs: config.ttsTimeoutMs })(pricing),
    video: (pricing, mode) => createVideoProviderFactory(mode === "real" ? "runway" : "mock", { apiKey: readRunwayApiKey(env), uploadsDir: config.uploadsDir })(pricing),
    presenter: (pricing, mode) => mode === "real" ? new RunwayPresenterProvider({ pricing, apiKey: readRunwayApiKey(env) ?? "" }) : new MockPresenterProvider(pricing),
    renderer: mode => mode === "real" ? renderer : mockRenderer,
  };
  // A fábrica offline mantém o storage local e os defaults; o serviço híbrido faz o roteamento.
  const ugcProviders = createUgcProviderFactories({ mockAudioStrategy: config.ugcMockAudioStrategy, google: googleUgcRuntime(config, env), krea: kreaUgcRuntime(config, env) });
  const ugcChoice = config.ugc.provider === "krea" ? kreaUgcPricingRefs : undefined;
  return createOfflinePipelineService(config, { ugcProviders, ugcChoice, ...overrides, hybrid: overrides.hybrid ?? hybrid, ids });
}
