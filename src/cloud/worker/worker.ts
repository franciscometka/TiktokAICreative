import type { GenerationOutcome } from "@/pipeline/pipeline-service";
import type { Logger } from "../logger";
import type { QueueStatus, QueueTask } from "../queue/job-queue";
import { paidOperationInFlight } from "../repos/progress";
import { dataDirs, workerUserRuntime, type CloudInfra, type UserRuntime } from "../runtime";
import { AssetSync } from "./asset-sync";
import { cleanupStaleWorkspaces, createWorkspace, removeWorkspace } from "./temp-workspace";

/**
 * Render Background Worker (D104). Consome tarefas persistidas e executa as etapas pesadas
 * (Claude, referência, Krea/Veo, ElevenLabs, downloads, FFmpeg/silencedetect, Remotion,
 * mediaCheck, upload). Independe do navegador: o estado está no banco e os arquivos no Storage.
 *
 * Uma tarefa por vez por processo (o cwd vira o workspace do job); escala com mais instâncias.
 *
 * REGRA ABSOLUTA mantida: nenhuma chamada paga é refeita automaticamente. Na retomada após
 * queda, tarefa com operação paga em voo vira `blocked` e espera ação explícita do usuário.
 */

export interface WorkerOptions {
  infra: CloudInfra;
  workerId: string;
  tmpRoot: string;
  /** Raiz do app (código Remotion, node_modules). */
  projectRoot: string;
  leaseSeconds: number;
  pollIntervalMs: number;
  staleTmpHours?: number;
  /** false = não troca o cwd (testes paralelos). O workspace continua sendo a raiz dos assets. */
  chdir?: boolean;
  runtimeFor?: (infra: CloudInfra, userId: string, roots: { projectRoot: string; assetRoot: string }) => UserRuntime;
  logger?: Logger;
}

type Finish = { status: Exclude<QueueStatus, "queued" | "running">; outcome: string; error?: string; blockedReason?: string };

export function finishForOutcome(outcome: GenerationOutcome): Finish {
  switch (outcome.kind) {
    case "COMPLETED": return { status: "completed", outcome: "completed" };
    case "FAILED": return { status: "failed", outcome: "failed", error: outcome.error };
    case "AUDIO_REVIEW": return { status: "awaiting_approval", outcome: "audio_review" };
    case "BUDGET_EXCEEDED": return { status: "awaiting_approval", outcome: "budget_exceeded" };
    case "QUEUED": return { status: "completed", outcome: "queued" };
    case "WAITING_STAGE": {
      const inFlight = paidOperationInFlight(outcome.job);
      return inFlight
        ? { status: "blocked", outcome: "uncertain", blockedReason: `Operação paga sem confirmação (${inFlight}). Nada foi reenviado; retome explicitamente.` }
        : { status: "awaiting_approval", outcome: outcome.job.waitingForStage ? `waiting_${outcome.job.waitingForStage}` : "waiting" };
    }
  }
}

export class CloudWorker {
  private stopping = false;
  private current: Promise<void> | undefined;
  private lastRecovery = 0;
  private readonly log: Logger;

  constructor(private readonly options: WorkerOptions) {
    this.log = options.logger ?? options.infra.logger.child({ workerId: options.workerId });
  }

  private runtime(userId: string, assetRoot: string): UserRuntime {
    return (this.options.runtimeFor ?? workerUserRuntime)(this.options.infra, userId, { projectRoot: this.options.projectRoot, assetRoot });
  }

  /** Na subida: limpa temporários abandonados e recupera tarefas de workers mortos. */
  async startup(): Promise<void> {
    const removed = await cleanupStaleWorkspaces(this.options.tmpRoot, { maxAgeMs: (this.options.staleTmpHours ?? 12) * 3600_000 });
    if (removed.length) this.log.info("temporários abandonados removidos", { count: removed.length });
    await this.recoverExpired();
  }

  /** Uma volta do loop: retomada (no máx. a cada lease/2) + claim + execução. */
  async tick(): Promise<"idle" | "processed"> {
    if (Date.now() - this.lastRecovery > (this.options.leaseSeconds * 1000) / 2) await this.recoverExpired();
    const task = await this.options.infra.queue.claim(this.options.workerId, this.options.leaseSeconds);
    if (!task) return "idle";
    this.current = this.process(task);
    try { await this.current; } finally { this.current = undefined; }
    return "processed";
  }

  async run(): Promise<void> {
    await this.startup();
    while (!this.stopping) {
      let state: "idle" | "processed" = "idle";
      try { state = await this.tick(); } catch (error) { this.log.error("falha no loop do worker", { error }); }
      if (state === "idle" && !this.stopping) await new Promise((r) => setTimeout(r, this.options.pollIntervalMs));
    }
  }

  /** Para de pegar tarefas; espera a atual terminar (o lease cobre o caso de ser morto). */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.current?.catch(() => undefined);
  }

  async process(task: QueueTask): Promise<void> {
    const { infra } = this.options;
    const log = this.log.child({ taskId: task.id, projectId: task.campaignId, jobId: task.jobId ?? undefined, stage: task.payload.kind === "job_run" ? (task.payload.run as { stage?: string }).stage ?? task.payload.run.kind : "planning" });
    const key = task.jobId ?? `planning_${task.campaignId}`;
    const workspace = await createWorkspace(this.options.tmpRoot, key);
    const previousCwd = process.cwd();
    let lost = false;
    const beat = setInterval(() => {
      void infra.queue.heartbeat(task.id, this.options.workerId, this.options.leaseSeconds).then((ok) => {
        if (!ok && !lost) { lost = true; log.warn("lease perdido: a tarefa foi recuperada por outro processo"); }
      }).catch((error: unknown) => log.warn("heartbeat falhou", { error }));
    }, Math.max(1_000, (this.options.leaseSeconds * 1000) / 3));
    beat.unref?.();

    let finish: Finish = { status: "failed", outcome: "error", error: "Falha desconhecida" };
    let keepWorkspace = false;
    if (this.options.chdir !== false) process.chdir(workspace);
    const rt = this.runtime(task.userId, workspace);
    const sync = new AssetSync(infra.storage, rt.assets, dataDirs(infra.config), task.userId);
    try {
      log.info("tarefa iniciada", { kind: task.kind, attempt: task.attempts, paid: task.paid });
      const campaign = await rt.store.getCampaign(task.campaignId);
      const jobs = campaign.status === "planned" ? await rt.store.listJobs(campaign.id) : [];
      await sync.hydrate(workspace, campaign, jobs);
      if (task.payload.kind === "planning") {
        const done = await rt.deps.service.runPlanningTask(task.campaignId, task.payload.planningRunId, task.payload.realAuthorized);
        finish = done.status === "planned" ? { status: "completed", outcome: "planned" }
          : done.status === "failed" ? { status: "failed", outcome: "planning_failed", error: done.error ?? "Falha no planejamento" }
          : { status: "completed", outcome: "superseded" };
      } else {
        finish = finishForOutcome(await rt.deps.service.runJobTask(task.jobId!, task.payload.run));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const job = task.jobId ? await rt.store.getJob(task.jobId).catch(() => undefined) : undefined;
      const inFlight = job ? paidOperationInFlight(job) : undefined;
      finish = inFlight
        ? { status: "blocked", outcome: "uncertain", error: message, blockedReason: `Operação paga sem confirmação (${inFlight}). Nada foi reenviado.` }
        : { status: "failed", outcome: "error", error: message };
      log.error("tarefa falhou", { error });
    } finally {
      try {
        if (task.jobId) await rt.store.markProgress(task.jobId, "uploading", "Salvando arquivos");
        const published = await this.publishWithRetry(sync, workspace, task.campaignId);
        if (published.length) log.info("arquivos publicados no storage", { count: published.length });
        if (task.jobId) await rt.store.refreshProgress(task.jobId);
      } catch (error) {
        // Arquivos ficaram só no disco temporário: não limpa e bloqueia para decisão humana.
        keepWorkspace = true;
        finish = { status: "blocked", outcome: "upload_failed", error: finish.error, blockedReason: "Falha ao salvar os arquivos gerados no Storage. Nada pago foi refeito." };
        log.error("falha ao publicar arquivos", { error });
      }
      clearInterval(beat);
      if (this.options.chdir !== false) process.chdir(previousCwd);
      if (finish.status === "blocked" && task.jobId) await rt.store.markProgress(task.jobId, "blocked", finish.blockedReason ?? "Bloqueado").catch(() => undefined);
      if (!keepWorkspace) await removeWorkspace(this.options.tmpRoot, key).catch((error: unknown) => log.warn("não removeu temporário", { error }));
      const recorded = await infra.queue.finish(task.id, this.options.workerId, finish).catch(() => false);
      log.info("tarefa encerrada", { status: finish.status, outcome: finish.outcome, recorded });
    }
  }

  private async publishWithRetry(sync: AssetSync, workspace: string, campaignId: string): Promise<string[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await sync.publish(workspace, campaignId); } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw lastError;
  }

  /**
   * Retomada após queda/deploy/timeout (lease expirado):
   * - operação paga em voo (marcador antes do POST, sem confirmação) → `blocked`, sem reenvio;
   * - planejamento pago interrompido → `blocked` (refazer é ação explícita: nova chamada paga);
   * - render interrompido no meio → `failed` (o usuário pede "Renderizar novamente", grátis);
   * - nada em voo → volta para a fila (continua a sequência já aprovada), até max_attempts.
   */
  async recoverExpired(): Promise<number> {
    this.lastRecovery = Date.now();
    const { queue } = this.options.infra;
    let handled = 0;
    for (const task of await queue.expired()) {
      const rt = this.runtime(task.userId, this.options.tmpRoot);
      const decision = await this.decide(task, rt);
      if (await queue.recover(task.id, decision)) {
        handled++;
        if (decision.action === "block" && task.jobId) await rt.store.markProgress(task.jobId, "blocked", decision.reason).catch(() => undefined);
        this.log.warn("tarefa recuperada", { taskId: task.id, jobId: task.jobId ?? undefined, projectId: task.campaignId, action: decision.action, ...(decision.action !== "requeue" ? { reason: decision.reason } : {}) });
      }
    }
    return handled;
  }

  private async decide(task: QueueTask, rt: UserRuntime): Promise<{ action: "requeue" } | { action: "block"; reason: string } | { action: "fail"; reason: string }> {
    if (task.payload.kind === "planning") {
      if (task.paid) return { action: "block", reason: "Planejamento pago interrompido sem resposta. Nada foi reenviado; planeje de novo explicitamente." };
      return task.attempts < task.maxAttempts ? { action: "requeue" } : { action: "fail", reason: "Planejamento interrompido repetidamente." };
    }
    const job = await rt.store.getJob(task.jobId!).catch(() => undefined);
    if (!job) return { action: "fail", reason: "Job não encontrado na retomada." };
    const inFlight = paidOperationInFlight(job);
    if (task.paid && inFlight) return { action: "block", reason: `Operação paga sem confirmação (${inFlight}). Nada foi reenviado; retome explicitamente.` };
    if (job.renders.some((r) => r.status === "rendering")) return { action: "fail", reason: "Render interrompido. Use \"Renderizar novamente\" (sem custo)." };
    return task.attempts < task.maxAttempts ? { action: "requeue" } : { action: "fail", reason: "Tarefa interrompida repetidamente." };
  }
}
