import { MockCreativePlanner } from "@/ai/mock-planner";
import { PRICING_TABLE } from "@/config/pricing";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { StaticExchangeRateProvider } from "@/costs/exchange-rate";
import { InMemoryCostLedger } from "@/costs/ledger";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import type { CostBudget, ExchangeRate, ProviderPricing } from "@/domain/cost";
import type { CreativePlan } from "@/domain/creative";
import type { CampaignRequest } from "@/domain/pipeline";
import type { ProductInput } from "@/domain/product";
import { fixedClock } from "@/lib/clock";
import { sequentialIds } from "@/lib/ids";
import { MockAudioProvider, type MockAudioProviderOptions } from "@/providers/audio/mock-audio-provider";
import { MockVideoProvider, type MockVideoProviderOptions } from "@/providers/video/mock-video-provider";
import { MockRenderer, type Renderer } from "@/render/renderer";
import { InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { InMemoryPipelineStore } from "@/storage/pipeline-store";
import type { CreativePlanner } from "@/ai/planner";
import type { PipelineStore } from "@/storage/pipeline-store";
import type { CostLedger } from "@/costs/ledger";
import type { LlmCallLog } from "@/storage/llm-call-log";
import type { IdGenerator } from "@/lib/ids";
import { PipelineService } from "@/pipeline/pipeline-service";

export const RATE: ExchangeRate = { base: "USD", quote: "BRL", rate: 5, source: "default", updatedAt: "2026-10-13" };

export const catalog = new StaticPricingCatalog(PRICING_TABLE);

export function pricing(over: Partial<ProviderPricing> = {}): ProviderPricing {
  return {
    provider: "test",
    model: "test-model",
    unit: "per_second",
    priceUsd: 0.1,
    updatedAt: "2026-10-13",
    isPlaceholder: false,
    ...over,
  };
}

export function product(over: Partial<ProductInput> = {}): ProductInput {
  return {
    id: "prod_1",
    name: "Garrafa Térmica X",
    description: "Garrafa térmica de aço inox que mantém a bebida gelada por 24h.",
    features: ["Aço inox", "750ml"],
    benefits: ["Bebida gelada o dia todo", "Não vaza na mochila"],
    priceBrl: 89.9,
    images: [
      { id: "img_1", uri: "outputs/uploads/img_1.jpg" },
      { id: "img_2", uri: "outputs/uploads/img_2.jpg" },
    ],
    ...over,
  };
}

export const BUDGET: CostBudget = { maxCostPerCreativeBrl: 15, maxCostPerCampaignBrl: 100, allowOverBudget: true };

export function campaignRequest(over: Partial<CampaignRequest> = {}): CampaignRequest {
  return {
    product: product(),
    styles: ["ugc", "problem_solution"],
    creativeCount: 1,
    quality: "economy",
    budget: BUDGET,
    ...over,
  };
}

/** Plano válido simples: 2 cenas, 1 com vídeo IA. */
export function simplePlan(over: Partial<CreativePlan> = {}): CreativePlan {
  return {
    id: "creative_1",
    productId: "prod_1",
    concept: {
      id: "concept_1",
      title: "Teste",
      angle: "praticidade",
      hook: "Olha isso",
      targetEmotion: "curiosidade",
      format: "ugc",
      description: "desc",
    },
    duration: 20,
    hook: "Olha isso",
    script: "roteiro",
    callToAction: "Compre agora",
    scenes: [
      {
        id: "scene_1",
        order: 0,
        duration: 8,
        narration: "a".repeat(100),
        onScreenText: "Olha isso",
        visualDescription: "close",
        generationPrompt: "close up do produto",
        shotType: "close_up",
        visualSource: "generated_video",
        motion: "none",
        requiresGeneratedVideo: true,
        estimatedGenerationSeconds: 8,
      },
      {
        id: "scene_2",
        order: 1,
        duration: 12,
        narration: "b".repeat(200),
        onScreenText: "Compre",
        visualDescription: "imagem do produto",
        generationPrompt: "",
        shotType: "product_detail",
        visualSource: "product_image",
        motion: "ken_burns",
        requiresGeneratedVideo: false,
        estimatedGenerationSeconds: 0,
      },
    ],
    ...over,
  };
}

export interface HarnessOptions {
  quality?: keyof typeof QUALITY_PRESETS;
  video?: Omit<MockVideoProviderOptions, "pricing">;
  audio?: Omit<MockAudioProviderOptions, "pricing">;
  maxAttemptsPerScene?: number;
  /** Para trocar o planner (ex.: LlmCreativePlanner com cliente falso) e a persistência. */
  planner?: (ids: IdGenerator) => CreativePlanner;
  storage?: { store: PipelineStore; ledger: CostLedger; llmCallLog: LlmCallLog };
  ids?: IdGenerator;
  /** Renderer controlável (testes de render em andamento/falha). Padrão: MockRenderer. */
  renderer?: Renderer;
}

/** Pipeline completo com mocks compartilhados para inspeção nos testes. */
export function createHarness(options: HarnessOptions = {}) {
  const settings = QUALITY_PRESETS[options.quality ?? "economy"];
  const ids = options.ids ?? sequentialIds();
  const video = new MockVideoProvider({ pricing: catalog.requireOne(settings.video), ...options.video });
  const audio = new MockAudioProvider({ pricing: catalog.requireOne(settings.audio), ...options.audio });
  const renderer = options.renderer ?? new MockRenderer();
  const { store, ledger, llmCallLog } = options.storage ?? {
    store: new InMemoryPipelineStore(),
    ledger: new InMemoryCostLedger(),
    llmCallLog: new InMemoryLlmCallLog(),
  };
  const service = new PipelineService({
    planner: options.planner ? options.planner(ids) : new MockCreativePlanner(ids),
    llmCallLog,
    videoProviderFactory: () => video,
    audioProviderFactory: () => audio,
    renderer,
    store,
    ledger,
    pricing: catalog,
    exchangeRates: new StaticExchangeRateProvider(RATE),
    maxAttemptsPerScene: options.maxAttemptsPerScene ?? 3,
    pollOptions: { maxPolls: 5, intervalMs: 0, sleep: async () => {} },
    outputDir: "outputs",
    clock: fixedClock(),
    ids,
  });
  return { service, video, audio, renderer, store, ledger, llmCallLog, settings, ids };
}
