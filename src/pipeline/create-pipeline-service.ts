import { createAnthropicLlmClient } from "@/ai/create-llm-client";
import { createUgcProviderFactories } from "@/providers/ugc";
import { LocalUgcAssetStore } from "@/storage/ugc-asset-store";
import { googleUgcRuntime } from "@/providers/ugc/google-runtime";
import { LlmError } from "@/ai/llm-client";
import { LlmCreativePlanner } from "@/ai/llm-planner";
import { UnavailablePlanner } from "@/ai/unavailable-planner";
import { MockCreativePlanner } from "@/ai/mock-planner";
import type { CreativePlanner } from "@/ai/planner";
import { readElevenLabsApiKey, readRemotionLicenseKey, readRunwayApiKey, type AppConfig } from "@/config/env";
import { RunwayPresenterProvider } from "@/providers/presenter/runway-presenter-provider";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { LocalVideoAssetStore } from "@/storage/video-asset-store";
import { PRICING_TABLE } from "@/config/pricing";
import { StaticExchangeRateProvider } from "@/costs/exchange-rate";
import { InMemoryCostLedger } from "@/costs/ledger";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { systemClock } from "@/lib/clock";
import { randomId, type IdGenerator } from "@/lib/ids";
import { createAudioProviderFactory } from "@/providers/audio";
import { DEFAULT_POLL_OPTIONS } from "@/providers/poll";
import { createVideoProviderFactory } from "@/providers/video";
import { createRenderer } from "@/render/create-renderer";
import { LocalAudioAssetStore } from "@/storage/audio-asset-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileLlmCallLog, InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { InMemoryPipelineStore } from "@/storage/pipeline-store";
import { PipelineService, type PipelineDeps } from "./pipeline-service";

function createPlanner(config: AppConfig, ids: IdGenerator, env: Record<string, string | undefined>): CreativePlanner {
  switch (config.llmProvider) {
    case "mock":
      return new MockCreativePlanner(ids, config.mockPlannerDelayMs);
    case "anthropic": {
      let client;
      try {
        client = createAnthropicLlmClient(config, env);
      } catch (error) {
        // Sem chave: o app abre normalmente; só criar/replanejar campanha é recusado.
        if (error instanceof LlmError) return new UnavailablePlanner("anthropic", error);
        throw error;
      }
      return new LlmCreativePlanner(client, ids, {
        maxValidationAttempts: config.llmPolicy.maxValidationAttempts,
      });
    }
  }
}

function createStorage(config: AppConfig): Pick<PipelineDeps, "store" | "ledger" | "llmCallLog"> {
  if (config.storage === "memory") {
    return { store: new InMemoryPipelineStore(), ledger: new InMemoryCostLedger(), llmCallLog: new InMemoryLlmCallLog() };
  }
  return {
    store: new FilePipelineStore(config.dataDir),
    ledger: new FileCostLedger(config.dataDir),
    llmCallLog: new FileLlmCallLog(config.dataDir),
  };
}

/**
 * Raiz de composição: o ÚNICO lugar que escolhe implementações concretas.
 * Planner mock ou Claude (LLM_PROVIDER); renderer mock ou Remotion (RENDERER); áudio mock ou
 * ElevenLabs (AUDIO_PROVIDER); vídeo mock ou Runway (VIDEO_PROVIDER);
 * persistência local em arquivos (STORAGE=file, padrão) ou memória.
 */
export function createPipelineService(
  config: AppConfig,
  overrides: Partial<PipelineDeps> = {},
  env: Record<string, string | undefined> = process.env,
): PipelineService {
  const ids = overrides.ids ?? randomId;
  return new PipelineService({
    planner: overrides.planner ?? createPlanner(config, ids, env),
    videoProviderFactory: createVideoProviderFactory(config.videoProvider, { apiKey: readRunwayApiKey(env), uploadsDir: config.uploadsDir }),
    videoChoice: config.videoProvider === "runway" ? RUNWAY_VIDEO : undefined,
    videoAssets: new LocalVideoAssetStore(config.videosDir),
    presenterProviderFactory: pricing => new RunwayPresenterProvider({ pricing, apiKey: readRunwayApiKey(env) ?? "" }),
    audioProviderFactory: createAudioProviderFactory(config.audioProvider, {
      elevenLabsApiKey: readElevenLabsApiKey(env),
      ttsTimeoutMs: config.ttsTimeoutMs,
    }),
    audioAssets: new LocalAudioAssetStore(config.audioDir),
    ugcAssets: new LocalUgcAssetStore(config.ugcDir),
    ugcProviders: createUgcProviderFactories({ mockAudioStrategy: config.ugcMockAudioStrategy, google: googleUgcRuntime(config, env) }),
    renderer: createRenderer(config.renderer.id, {
      rendersDir: config.rendersDir,
      allowedAssetRoots: [config.uploadsDir, config.audioDir, config.videosDir, config.ugcDir],
      concurrency: config.renderer.concurrency,
      debug: config.renderer.debug,
      browserExecutable: config.renderer.browserExecutable,
      licenseKey: readRemotionLicenseKey(env),
    }),
    ...createStorage(config),
    pricing: new StaticPricingCatalog(PRICING_TABLE),
    exchangeRates: new StaticExchangeRateProvider(config.exchangeRate),
    maxAttemptsPerScene: config.maxAttemptsPerScene,
    pollOptions: DEFAULT_POLL_OPTIONS,
    outputDir: "outputs",
    clock: systemClock,
    ids,
    ...overrides,
  });
}
