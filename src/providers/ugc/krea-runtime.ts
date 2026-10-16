import { readKreaApiKey, type AppConfig } from "@/config/env";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { localImageLoader } from "./google-transports";
import type { KreaUgcRuntime } from "./index";

/** Monta o runtime Krea do servidor: chave lida do ambiente, preflight local e leitor de imagens. */
export function kreaUgcRuntime(config: AppConfig, env: Record<string, string | undefined> = process.env, transport?: typeof fetch): KreaUgcRuntime {
  return {
    apiKey: readKreaApiKey(env),
    readiness: kreaUgcReadiness(config, env),
    loadImage: localImageLoader([config.uploadsDir, config.ugcDir]),
    ...(transport ? { transport } : {}),
  };
}
