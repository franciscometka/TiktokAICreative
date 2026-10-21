import { createHybridPipelineService } from "@/pipeline/hybrid-service";
import type { AppDeps } from "@/application/campaign-actions";
import { loadAppConfigSafe, type AppConfig, type ConfigIssue } from "@/config/env";
import { mocksAllowed } from "@/config/execution-policy";
import type { PresetSummary } from "@/costs/preset-summary";
import { LocalUploadStore } from "@/storage/upload-store";
import { FileAvatarLibraryStore } from "@/storage/avatar-store";
import type { V2EstimateView } from "@/application/create-v2";
import { presetSummariesFor, publicConfigFor, v2EstimatesFor, type PublicAppConfig } from "@/application/public-config";

/**
 * Runtime do processo Next.js (SERVIDOR). Um único PipelineService por processo: ele guarda os
 * locks por campanha e os planejamentos em execução. Guardado em globalThis para sobreviver ao
 * hot reload do `next dev` (senão um planejamento em andamento pareceria interrompido).
 *
 * Só importar a partir de Server Components, Server Actions e route handlers.
 */

interface Runtime {
  config: AppConfig;
  configIssues: ConfigIssue[];
  deps: AppDeps;
}

const KEY = Symbol.for("tiktok-ai-creative-factory.runtime");
type GlobalWithRuntime = typeof globalThis & { [KEY]?: Runtime };

export function getRuntime(): Runtime {
  const g = globalThis as GlobalWithRuntime;
  if (!g[KEY]) {
    const { config, issues: configIssues } = loadAppConfigSafe();
    g[KEY] = {
      config,
      configIssues,
      deps: {
        service: createHybridPipelineService(config, {}, process.env, configIssues),
        uploads: new LocalUploadStore(config.uploadsDir),
        rendersDir: config.rendersDir,
        audioDir: config.audioDir,
        ugcDir: config.ugcDir,
        videosDir: config.videosDir,
        audioProvider: config.audioProvider,
        offlineOnly: false,
        allowMocks: mocksAllowed(config),
        avatars: new FileAvatarLibraryStore(config.dataDir),
      },
    };
  }
  // Runtime criado por uma versão anterior (hot reload): acrescenta a biblioteca de avatares sem
  // recriar o PipelineService (que guarda locks e execuções em andamento).
  g[KEY].deps.avatars ??= new FileAvatarLibraryStore(g[KEY].config.dataDir);
  return g[KEY];
}

export type { PublicAppConfig } from "@/application/public-config";

/** Configuração SEGURA para a interface (mesma função pura usada pela API cloud). */
export function getPublicConfig(): PublicAppConfig {
  const { config, configIssues } = getRuntime();
  return publicConfigFor(config, configIssues, process.env);
}

/** Lote 6: estimativas da UX V2 (duração × qualidade), calculadas no servidor pela tabela de preços. */
export function getV2Estimates(): V2EstimateView[] {
  return v2EstimatesFor(getRuntime().config);
}

export function getPresetSummaries(): PresetSummary[] {
  return presetSummariesFor(getRuntime().config);
}
