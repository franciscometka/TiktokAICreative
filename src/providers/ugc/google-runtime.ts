import { readGoogleAiApiKey, type AppConfig } from "@/config/env";
import { googleUgcReadiness } from "@/config/ugc-readiness";
import { localImageLoader } from "./google-transports";
import type { GoogleUgcRuntime } from "./index";

/** Monta o runtime Google do servidor: chave lida do ambiente, preflight local e leitor de imagens. */
export function googleUgcRuntime(config: AppConfig, env: Record<string, string | undefined> = process.env, transport?: typeof fetch): GoogleUgcRuntime {
  return {
    apiKey: readGoogleAiApiKey(env),
    readiness: googleUgcReadiness(config, env),
    loadImage: localImageLoader([config.uploadsDir, config.ugcDir]),
    ...(transport ? { transport } : {}),
  };
}
