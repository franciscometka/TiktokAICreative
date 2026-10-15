import type { AppConfig } from "@/config/env";
import { offlineConfig } from "@/config/execution-policy";
import { MockPresenterProvider } from "@/providers/presenter/mock-presenter-provider";
import type { RenderManifest } from "@/domain/render";
import { MockRenderer, type RenderOptions } from "@/render/renderer";
import { createPipelineService } from "./create-pipeline-service";
import type { PipelineDeps } from "./pipeline-service";
export class VersionedMockRenderer extends MockRenderer {
  override async render(manifest: RenderManifest, options?: RenderOptions) {
    const result = await super.render(manifest);
    const renderId = `v${options?.preferredVersion ?? this.renderCalls.length}`;
    return { ...result, renderId, outputUri: `mock://render/${manifest.creativeId}/${renderId}.mp4`, durationSeconds: manifest.duration };
  }
}
export function createOfflinePipelineService(config: AppConfig, overrides: Partial<PipelineDeps> = {}) {
  return createPipelineService(offlineConfig(config), { presenterProviderFactory: pricing => new MockPresenterProvider(pricing),
    renderer: new VersionedMockRenderer(), stageDelayMs: 350, ...overrides, offlineOnly: !overrides.hybrid });
}
