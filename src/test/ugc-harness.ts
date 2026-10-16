import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockCreativePlanner } from "@/ai/mock-planner";
import { loadAppConfig } from "@/config/env";
import { MOCK_STAGE_MODES, type StageModes } from "@/domain/execution";
import type { CampaignRequest } from "@/domain/pipeline";
import type { UgcAudioStrategy } from "@/domain/ugc";
import { randomId } from "@/lib/ids";
import { MockAudioProvider } from "@/providers/audio/mock-audio-provider";
import { MockPresenterProvider } from "@/providers/presenter/mock-presenter-provider";
import { MockUgcReferenceProvider, MockUgcVideoProvider } from "@/providers/ugc/mock-ugc-providers";
import type { UgcReferenceRequest } from "@/providers/ugc/ugc-providers";
import { MockVideoProvider } from "@/providers/video/mock-video-provider";
import type { ProviderPricing } from "@/domain/cost";
import { InMemoryUgcAssetStore } from "@/storage/ugc-asset-store";
import { createHybridPipelineService } from "@/pipeline/hybrid-service";
import { VersionedMockRenderer } from "@/pipeline/offline-service";
import type { PipelineDeps } from "@/pipeline/pipeline-service";
import { campaignRequest, product } from "./fixtures";

/** Referência "REAL" falsa (sem rede): devolve bytes PNG, custo NÃO simulado. */
export class FakeRealUgcReferenceProvider extends MockUgcReferenceProvider {
  override readonly descriptor;
  constructor(pricing: ProviderPricing) {
    super(pricing);
    this.descriptor = { id: "google", model: pricing.model, isMock: false, pricing };
  }
  override async submit(request: UgcReferenceRequest) { return super.submit(request); }
  override async downloadResult(ref: { providerJobId: string }) {
    const base = await super.downloadResult(ref);
    return { ...base, uri: "", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), isMock: false };
  }
}

/**
 * Serviço híbrido completo, 100% offline, com espiões em TODOS os providers para provar:
 * referência antes de cena, mesma identidade, separação Presenter × UGC e nenhuma chamada extra.
 */
export async function ugcHarness(options: {
  strategy?: UgcAudioStrategy;
  modes?: Partial<StageModes>;
  request?: Partial<CampaignRequest>;
  realReference?: boolean;
  /** Factories completas (ex.: providers Google reais com fetch falso). */
  ugcProviders?: PipelineDeps["ugcProviders"];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ugc-"));
  const config = loadAppConfig({ DATA_DIR: join(root, "data"), AUDIO_DIR: join(root, "audio"), VIDEOS_DIR: join(root, "videos"), RENDERS_DIR: join(root, "renders"), UGC_DIR: join(root, "ugc") });
  const spies = {
    references: [] as MockUgcReferenceProvider[],
    videos: [] as MockUgcVideoProvider[],
    audio: [] as MockAudioProvider[],
    presenter: [] as MockPresenterProvider[],
    video: [] as MockVideoProvider[],
  };
  const capabilities = Object.fromEntries(["planning", "narration", "scenes", "avatar", "ugc_reference", "ugc_video", "render"].map((s) => [s, { available: true, provider: "fake" }])) as NonNullable<PipelineDeps["hybrid"]>["capabilities"];
  const renderer = new VersionedMockRenderer();
  const hybrid: NonNullable<PipelineDeps["hybrid"]> = {
    capabilities,
    planner: () => new MockCreativePlanner(randomId),
    audio: (pricing) => { const p = new MockAudioProvider({ pricing }); spies.audio.push(p); return p; },
    video: (pricing) => { const p = new MockVideoProvider({ pricing }); spies.video.push(p); return p; },
    presenter: (pricing) => { const p = new MockPresenterProvider(pricing); spies.presenter.push(p); return p; },
    renderer: () => renderer,
  };
  const strategy = options.strategy ?? "native_speech";
  const ugcAssets = new InMemoryUgcAssetStore();
  const build = () => createHybridPipelineService(config, {
    hybrid,
    stageDelayMs: 0,
    ugcAssets,
    pollOptions: { maxPolls: 2, intervalMs: 0, sleep: async () => {} },
    ugcProviders: options.ugcProviders ?? {
      reference: (pricing, mode) => {
        const p = mode === "real" && options.realReference ? new FakeRealUgcReferenceProvider(pricing) : new MockUgcReferenceProvider(pricing);
        spies.references.push(p);
        return p;
      },
      video: (pricing) => { const p = new MockUgcVideoProvider(pricing, strategy); spies.videos.push(p); return p; },
    },
  });
  const service = build();
  const request = campaignRequest({
    product: product({ images: [{ id: "img_1", uri: "outputs/uploads/prod_1/img_1.png" }] }),
    simpleFlow: true,
    creativeMode: "ai_ugc",
    ugc: { presenter: "woman", environment: "auto", visualStyle: "natural_smartphone" },
    stageModes: { ...MOCK_STAGE_MODES, ...options.modes },
    quality: "high",
    ...options.request,
  });
  const campaign = await service.planCampaign(request);
  const jobId = campaign.jobIds[0]!;
  const calls = {
    references: () => spies.references.flatMap((p) => p.calls),
    videos: () => spies.videos.flatMap((p) => p.calls),
    narrations: () => spies.audio.flatMap((p) => p.generateCalls),
    presenter: () => spies.presenter.length,
    productVideos: () => spies.video.flatMap((p) => p.generateCalls),
  };
  const run = async (target = service) => {
    const quote = await target.quoteJob(jobId);
    if (!quote.ready) throw new Error(quote.blocked);
    return (await target.authorizeAndRunJob(jobId, quote.token)).completion;
  };
  return { root, config, service, build, campaign, jobId, calls, run, renderer, ugcAssets };
}
