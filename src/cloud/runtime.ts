import type { AppDeps } from "@/application/campaign-actions";
import type { AppConfig, ConfigIssue } from "@/config/env";
import { mocksAllowed } from "@/config/execution-policy";
import { createHybridPipelineService } from "@/pipeline/hybrid-service";
import type { PipelineDeps } from "@/pipeline/pipeline-service";
import type { AssetStore } from "./assets/asset-store";
import { CloudUploadStore } from "./assets/cloud-upload-store";
import type { DataDirs } from "./assets/storage-layout";
import type { SqlClient } from "./db/sql";
import type { Logger } from "./logger";
import { QueueDispatcher, SetActivity, type PostgresJobQueue } from "./queue/job-queue";
import { AssetRepository } from "./repos/asset-repository";
import { PostgresAvatarLibraryStore } from "./repos/avatar-repository";
import { PostgresCostLedger, PostgresLlmCallLog } from "./repos/ledger-repository";
import { PostgresPipelineStore } from "./repos/pipeline-repository";

/**
 * Raiz de composição do modo cloud (D101). Monta, POR USUÁRIO AUTENTICADO, as mesmas AppDeps
 * que o Next usa localmente — só trocando as implementações (Postgres/Storage/fila). A regra de
 * negócio continua inteira em application/ + PipelineService (nada duplicado na API).
 */

export interface CloudInfra {
  db: SqlClient;
  storage: AssetStore;
  queue: PostgresJobQueue;
  config: AppConfig;
  configIssues: ConfigIssue[];
  env: Record<string, string | undefined>;
  logger: Logger;
  signedUrlTtlSeconds: number;
}

export interface UserRuntime {
  userId: string;
  deps: AppDeps & { uploads: CloudUploadStore };
  store: PostgresPipelineStore;
  assets: AssetRepository;
}

export function dataDirs(config: AppConfig): DataDirs {
  return { uploadsDir: config.uploadsDir, ugcDir: config.ugcDir, videosDir: config.videosDir, audioDir: config.audioDir, rendersDir: config.rendersDir };
}

/** Lock entre processos por campanha: advisory lock do Postgres. */
export function pgLocks(db: SqlClient, timeoutMs: number): NonNullable<PipelineDeps["locks"]> {
  return { run: (key, fn) => db.withLock(`campaign:${key}`, fn, { timeoutMs }) };
}

/**
 * API: o PipelineService só valida/persiste e ENFILEIRA (dispatcher); o "está ativo?" vem da
 * fila (activity) — fechar o navegador ou trocar de instância não faz o job parecer interrompido.
 */
export async function apiUserRuntime(infra: CloudInfra, userId: string): Promise<UserRuntime> {
  const activity = new SetActivity(await infra.queue.activeKeys(userId));
  return userRuntime(infra, userId, {
    dispatcher: new QueueDispatcher(infra.queue, userId),
    activity,
    // A API nunca espera o worker: lock ocupado por muito tempo = "em andamento" (409).
    locks: pgLocks(infra.db, 5_000),
  });
}

/**
 * Worker: mesmo serviço, SEM dispatcher (executa a tarefa aqui), com lock entre processos e
 * assets relativos ao workspace temporário do job (cwd da tarefa).
 */
export function workerUserRuntime(infra: CloudInfra, userId: string, roots: { projectRoot: string; assetRoot: string }): UserRuntime {
  return userRuntime(infra, userId, { locks: pgLocks(infra.db, 60_000) }, roots);
}

function userRuntime(infra: CloudInfra, userId: string, overrides: Partial<PipelineDeps>, roots?: { projectRoot: string; assetRoot: string }): UserRuntime {
  const store = new PostgresPipelineStore(infra.db, userId);
  const assets = new AssetRepository(infra.db, userId);
  const uploads = new CloudUploadStore(assets, infra.storage, dataDirs(infra.config), userId);
  const service = createHybridPipelineService(
    infra.config,
    { store, ledger: new PostgresCostLedger(infra.db, userId), llmCallLog: new PostgresLlmCallLog(infra.db, userId), ...overrides },
    infra.env,
    infra.configIssues,
    roots,
  );
  return {
    userId,
    store,
    assets,
    deps: {
      service,
      uploads,
      rendersDir: infra.config.rendersDir,
      audioDir: infra.config.audioDir,
      ugcDir: infra.config.ugcDir,
      videosDir: infra.config.videosDir,
      audioProvider: infra.config.audioProvider,
      offlineOnly: false,
      allowMocks: mocksAllowed(infra.config),
      avatars: new PostgresAvatarLibraryStore(infra.db, userId),
    },
  };
}
