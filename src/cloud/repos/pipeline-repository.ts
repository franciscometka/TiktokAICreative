import type { ProjectFacts } from "@/application/project-facts";
import { createHash } from "node:crypto";
import { CampaignSchema, GenerationJobSchema, type Campaign, type GenerationJob } from "@/domain/pipeline";
import { CorruptedDataError } from "@/storage/atomic-file";
import { NotFoundError, type PipelineStore } from "@/storage/pipeline-store";
import type { SqlClient, SqlExecutor } from "../db/sql";
import { timestamp } from "../db/time";
import { progressStageOf, type ProgressStage } from "./progress";

/**
 * PipelineStore no Postgres (PERSISTENCE_DRIVER=supabase). Mesmo contrato do FilePipelineStore:
 * campanha e job são documentos validados por Zod. TODA query é filtrada pelo usuário dono
 * (escopo do construtor), que vem do JWT validado — nunca do corpo do request.
 *
 * Ao gravar um job, no MESMO commit: colunas de status/progresso, projeções consultáveis
 * (ugc_references, render_jobs, job_attempts) e um job_event quando o status/progresso muda.
 */

export class OwnershipError extends Error {
  override name = "NotFoundError";
}

function parseDoc<T>(raw: unknown, parse: (data: unknown) => T, what: string): T {
  try {
    return parse(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (error) {
    throw new CorruptedDataError(`${what} ilegível no banco: ${error instanceof Error ? error.message.slice(0, 200) : "inválido"}`);
  }
}

const attemptId = (...parts: string[]) => `att_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;

export class PostgresPipelineStore implements PipelineStore {
  constructor(private readonly db: SqlClient, readonly userId: string) {}

  async saveCampaign(campaign: Campaign): Promise<void> {
    const doc = CampaignSchema.parse(campaign);
    await this.db.transaction(async (tx) => {
      const r = await tx.query(
        `insert into campaigns (id, user_id, status, document, created_at, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         on conflict (id) do update set status = excluded.status, document = excluded.document,
           updated_at = excluded.updated_at, revision = campaigns.revision + 1
         where campaigns.user_id = excluded.user_id`,
        [doc.id, this.userId, doc.status, JSON.stringify(doc), timestamp(doc.createdAt), timestamp(doc.updatedAt)],
      );
      if (r.rowCount === 0) throw new OwnershipError(`Campanha não encontrada: ${doc.id}`);
      await tx.query(
        `insert into projects (id, user_id, title, status, ux_version, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set title = excluded.title, status = excluded.status, ux_version = excluded.ux_version, updated_at = excluded.updated_at`,
        [doc.id, this.userId, (doc.request.projectName ?? doc.request.product.name).slice(0, 200), doc.status, doc.request.uxVersion ?? null, timestamp(doc.createdAt), timestamp(doc.updatedAt)],
      );
    });
  }

  async getCampaign(id: string): Promise<Campaign> {
    const r = await this.db.query<{ document: unknown }>("select document from campaigns where id = $1 and user_id = $2", [id, this.userId]);
    if (!r.rows[0]) throw new NotFoundError(`Campanha não encontrada: ${id}`);
    return parseDoc(r.rows[0].document, CampaignSchema.parse, `Campanha ${id}`);
  }

  async saveJob(job: GenerationJob): Promise<void> {
    const doc = GenerationJobSchema.parse(job);
    const progress = progressStageOf(doc);
    await this.db.transaction(async (tx) => {
      const previous = (await tx.query<{ status: string; progress_stage: string }>("select status, progress_stage from jobs where id = $1 and user_id = $2", [doc.id, this.userId])).rows[0];
      // Ownership: o job só entra se a campanha pertence ao mesmo usuário.
      const r = await tx.query(
        `insert into jobs (id, user_id, campaign_id, creative_id, status, current_stage, progress_stage, document, created_at, updated_at)
         select $1, $2, c.id, $4, $5, $6, $7, $8::jsonb, $9, $10 from campaigns c where c.id = $3 and c.user_id = $2
         on conflict (id) do update set status = excluded.status, current_stage = excluded.current_stage, progress_stage = excluded.progress_stage,
           document = excluded.document, updated_at = excluded.updated_at, revision = jobs.revision + 1
         where jobs.user_id = excluded.user_id and jobs.campaign_id = excluded.campaign_id`,
        [doc.id, this.userId, doc.campaignId, doc.creativeId, doc.status, doc.currentStage ?? null, progress, JSON.stringify(doc), timestamp(doc.createdAt), timestamp(doc.updatedAt)],
      );
      if (r.rowCount === 0) throw new OwnershipError(`Job não encontrado: ${doc.id}`);
      await this.project(tx, doc);
      if (!previous || previous.status !== doc.status || previous.progress_stage !== progress) {
        await tx.query(
          "insert into job_events (user_id, campaign_id, job_id, type, stage, message, data) values ($1, $2, $3, 'status', $4, $5, $6::jsonb)",
          [this.userId, doc.campaignId, doc.id, progress, `${previous?.status ?? "novo"} → ${doc.status}`, JSON.stringify({ status: doc.status, progress, error: doc.error?.slice(0, 300) })],
        );
      }
    });
  }

  /** Projeções do documento (consulta/auditoria). Idempotentes: upsert por id determinístico. */
  private async project(tx: SqlExecutor, job: GenerationJob): Promise<void> {
    for (const ref of job.ugc?.references ?? []) {
      await tx.query(
        `insert into ugc_references (id, user_id, job_id, campaign_id, version, state, approved, local_uri, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         on conflict (id) do update set state = excluded.state, approved = excluded.approved, local_uri = excluded.local_uri, updated_at = now()
         where ugc_references.user_id = excluded.user_id`,
        [`${job.id}:${ref.id}`, this.userId, job.id, job.campaignId, ref.version, ref.state, ref.review === "approved", ref.imageUri ?? null, timestamp(ref.createdAt)],
      );
    }
    for (const render of job.renders) {
      await tx.query(
        `insert into render_jobs (id, user_id, job_id, campaign_id, render_id, status, output_local_uri, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (id) do update set status = excluded.status, output_local_uri = excluded.output_local_uri, render_id = excluded.render_id, updated_at = now()
         where render_jobs.user_id = excluded.user_id`,
        [`${job.id}:${render.id}`, this.userId, job.id, job.campaignId, render.renderId ?? render.id, render.status, render.isMock ? null : render.outputUri ?? null, timestamp(render.startedAt)],
      );
    }
    // Operações pagas: attemptId estável + estado (started/submitted/confirmed/failed/uncertain).
    const attempts: { id: string; stage: string; provider: string | null; model: string | null; status: string; paid: boolean; ref: string | null; at: string }[] = [];
    for (const intent of job.stageIntents ?? []) {
      attempts.push({ id: attemptId(job.id, "intent", intent.stage, intent.createdAt), stage: intent.stage, provider: null, model: null, status: intent.state === "running" ? "started" : "confirmed", paid: true, ref: null, at: intent.createdAt });
    }
    for (const ref of job.ugc?.references ?? []) {
      const status = ref.state === "succeeded" ? "confirmed" : ref.state === "failed" ? "failed" : ref.state === "uncertain" ? "uncertain" : ref.state === "pending" ? "submitted" : "started";
      attempts.push({ id: attemptId(job.id, "ugc_reference", ref.id), stage: "ugc_reference", provider: ref.provider, model: ref.model, status, paid: !ref.isMock, ref: ref.providerJobId ?? null, at: ref.createdAt });
    }
    for (const op of job.ugcVideoOperations ?? []) {
      const status = op.state === "settled" ? (op.outcome === "failed" || op.outcome === "invalid_media" ? "failed" : "confirmed") : op.state === "uncertain" ? "uncertain" : op.state === "pending" ? "submitted" : "started";
      attempts.push({ id: attemptId(job.id, "ugc_video", op.attemptId), stage: "ugc_video", provider: op.provider, model: op.model, status, paid: true, ref: op.providerOperationId ?? null, at: op.createdAt });
    }
    const media = [...job.scenes.flatMap((s) => s.attempts), ...job.audioAttempts];
    for (const a of media) {
      attempts.push({ id: attemptId(job.id, "media", a.id), stage: a.kind === "audio" ? "narration" : "scenes", provider: a.provider, model: a.model, status: a.status === "succeeded" ? "confirmed" : "failed", paid: !a.isMock, ref: a.providerJobId, at: job.updatedAt });
    }
    for (const a of attempts) {
      await tx.query(
        `insert into job_attempts (id, user_id, job_id, campaign_id, stage, provider, model, status, paid, external_ref, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         on conflict (id) do update set status = excluded.status, external_ref = coalesce(excluded.external_ref, job_attempts.external_ref), updated_at = now()
         where job_attempts.user_id = excluded.user_id`,
        [a.id, this.userId, job.id, job.campaignId, a.stage, a.provider, a.model, a.status, a.paid, a.ref, timestamp(a.at)],
      );
    }
  }

  async getJob(id: string): Promise<GenerationJob> {
    const r = await this.db.query<{ document: unknown }>("select document from jobs where id = $1 and user_id = $2", [id, this.userId]);
    if (!r.rows[0]) throw new NotFoundError(`Job não encontrado: ${id}`);
    return parseDoc(r.rows[0].document, GenerationJobSchema.parse, `Job ${id}`);
  }

  /** Mesma regra do FilePipelineStore: a ordem vem de campaign.jobIds. */
  async listJobs(campaignId: string): Promise<GenerationJob[]> {
    const campaign = await this.getCampaign(campaignId);
    const r = await this.db.query<{ id: string; document: unknown }>("select id, document from jobs where campaign_id = $1 and user_id = $2", [campaignId, this.userId]);
    const byId = new Map(r.rows.map((row) => [row.id, row.document]));
    return campaign.jobIds.map((id) => {
      if (!byId.has(id)) throw new NotFoundError(`Job não encontrado: ${id}`);
      return parseDoc(byId.get(id), GenerationJobSchema.parse, `Job ${id}`);
    });
  }

  async listCampaignIds(): Promise<string[]> {
    const r = await this.db.query<{ id: string }>("select id from campaigns where user_id = $1 order by created_at desc", [this.userId]);
    return r.rows.map((row) => row.id);
  }

  /**
   * L8.8.1 — fatos mínimos de todos os projetos do usuário numa ÚNICA consulta. Extrai no banco
   * (jsonb/jsonpath) só os campos de `ProjectFacts`: sem documento, cenas, mídia ou ledger.
   * Mesmas regras de `projectFactsOf` (paridade coberta por teste).
   */
  async listProjectFacts(): Promise<ProjectFacts[]> {
    const r = await this.db.query<FactsRow>(PROJECT_FACTS_SQL, [this.userId]);
    return r.rows.map(factsFromRow);
  }

  /** Worker: marca progresso transitório ("uploading"/"blocked") sem tocar no documento. */
  async markProgress(jobId: string, progress: Extract<ProgressStage, "uploading" | "blocked">, message: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const r = await tx.query<{ campaign_id: string }>("update jobs set progress_stage = $3 where id = $1 and user_id = $2 returning campaign_id", [jobId, this.userId, progress]);
      if (!r.rows[0]) return;
      await tx.query("insert into job_events (user_id, campaign_id, job_id, type, stage, message) values ($1, $2, $3, 'progress', $4, $5)", [this.userId, r.rows[0].campaign_id, jobId, progress, message.slice(0, 500)]);
    });
  }

  /** Volta o progresso ao valor derivado do documento (fim do upload). */
  async refreshProgress(jobId: string): Promise<void> {
    const job = await this.getJob(jobId).catch(() => undefined);
    if (!job) return;
    const progress = progressStageOf(job);
    await this.db.transaction(async (tx) => {
      const r = await tx.query("update jobs set progress_stage = $3 where id = $1 and user_id = $2 and progress_stage <> $3", [jobId, this.userId, progress]);
      if (r.rowCount > 0) await tx.query("insert into job_events (user_id, campaign_id, job_id, type, stage, message) values ($1, $2, $3, 'progress', $4, $5)", [this.userId, job.campaignId, jobId, progress, `arquivos salvos; ${job.status}`]);
    });
  }
}

// ---------------------------------------------------------------- L8.8.1: fatos leves (shell/créditos)

/** Mesmas regras de `paidOperationInFlight` em jsonpath (paridade coberta por teste). */
export const PAID_IN_FLIGHT_PATHS = [
  `'$.stageIntents[*] ? (@.state == "running")'`,
  `'$.ugc.references[*] ? ((!exists(@.isMock) || @.isMock == false) && (@.state == "submitting" || @.state == "pending" || @.state == "uncertain"))'`,
  `'$.ugcVideoOperations[*] ? (@.state != "settled")'`,
  `'$.presenterTasks[*] ? (@.state == "pending" || @.state == "submitting")'`,
  `'$.videoTasks[*] ? (@.state == "submitting" || @.state == "pending")'`,
];
const PAID_IN_FLIGHT = PAID_IN_FLIGHT_PATHS.map((path) => `jsonb_path_exists(j.document, ${path})`).join(" or ");

export const PROJECT_FACTS_SQL = `
select c.id, c.status as campaign_status, c.created_at, c.updated_at,
  coalesce(nullif(c.document->'request'->>'projectName', ''), c.document->'request'->'product'->>'name') as name,
  (c.document->'request'->>'targetDurationSeconds')::float as target_seconds,
  (c.document->'planningRuns' is null and c.document->>'planningStartedAt' is null) as no_planning,
  j.id as job_id, j.status as job_status, j.document->>'updatedAt' as job_updated_at,
  (j.document->>'waitingForStage') is not null as waiting,
  (j.document->'jobAuthorization'->>'status') = 'paused' as auth_paused,
  coalesce(jsonb_path_exists(j.document, '$.scenes[*] ? (@.attempts[last].status == "failed")'), false) as last_attempt_failed,
  coalesce(${PAID_IN_FLIGHT}, false) as paid_in_flight,
  lr.x->>'id' as render_id, lr.n as render_index, coalesce((lr.x->>'isMock')::boolean, false) as render_mock, (lr.x->>'durationSeconds')::float as render_seconds,
  rr.done_at as real_done_at
from campaigns c
left join jobs j on j.user_id = c.user_id and j.id = c.document->'jobIds'->>0
left join lateral (
  select x, n from jsonb_array_elements(j.document->'renders') with ordinality as t(x, n)
  where x->>'status' = 'completed' order by n desc limit 1) lr on true
left join lateral (
  select max(coalesce(x->>'finishedAt', x->>'startedAt')) as done_at from jsonb_array_elements(j.document->'renders') as t(x)
  where x->>'status' = 'completed' and coalesce((x->>'isMock')::boolean, false) = false) rr on true
where c.user_id = $1
order by c.created_at desc`;

interface FactsRow {
  id: string; campaign_status: ProjectFacts["campaignStatus"]; created_at: Date | string; updated_at: Date | string; name: string; target_seconds: number | null; no_planning: boolean;
  job_id: string | null; job_status: NonNullable<ProjectFacts["job"]>["status"] | null; job_updated_at: string | null; waiting: boolean | null; auth_paused: boolean | null;
  last_attempt_failed: boolean; paid_in_flight: boolean; render_id: string | null; render_index: number | string | null; render_mock: boolean; render_seconds: number | null; real_done_at: string | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function factsFromRow(row: FactsRow): ProjectFacts {
  const hasRender = row.render_index !== null;
  return {
    id: row.id, name: row.name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    campaignStatus: row.campaign_status, neverStarted: row.campaign_status === "draft" && row.no_planning,
    targetSeconds: row.target_seconds,
    job: row.job_id && row.job_status ? {
      id: row.job_id, status: row.job_status, updatedAt: row.job_updated_at ?? iso(row.updated_at),
      waitingForStage: row.waiting === true, authorizationPaused: row.auth_paused === true,
      lastAttemptFailed: row.last_attempt_failed, paidOperationInFlight: row.paid_in_flight,
      // Mesmo id de `projectFactsOf`: o id da execução do render.
      lastRender: hasRender ? { id: row.render_id ?? "", isMock: row.render_mock, durationSeconds: row.render_seconds } : null,
      realVideoCompletedAt: row.real_done_at,
    } : null,
  };
}
