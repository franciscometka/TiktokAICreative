import { buildShellSummary } from "@/application/shell-summary";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { archiveAvatar, getAvatarDetail, getAvatarView, listAvatarViews, listVoiceProfileViews, saveAvatar, saveVoiceProfile, setAvatarActive } from "@/application/avatar-actions";
import {
  approveUgcReference,
  authorizeAndRunJob,
  cancelCreative,
  executeHybridPlanning,
  getCampaignView,
  retryFailedScene,
  regenerateStoryboardScene,
  regenerateUgcReference,
  rerenderCreative,
  retryCampaignPlanning,
  type ActionResult,
} from "@/application/campaign-actions";
import { imagePreviewUrl } from "@/application/campaign-view";
import { changeRequestCosts, startVideoV2 } from "@/application/create-v2";
import { buildProjectV2View, listProjectCards, matchesFilter, type ProjectFilter } from "@/application/project-v2-view";
import { presetSummariesFor, publicConfigFor, v2EstimatesFor } from "@/application/public-config";
import { toUserError, type UserError } from "@/application/user-errors";
import { workerStatusFrom } from "@/application/worker-status";
import { creditsSummary, loadCreditsView } from "@/application/credits";
import { SAFE_AVATAR_ID } from "@/domain/avatar";
import { parseChangeRequest } from "@/domain/change-request";
import { SAFE_PRODUCT_ID, STORED_IMAGE_NAME } from "@/domain/upload";
import { jobKey } from "@/pipeline/dispatch";
import { FINAL_FILE, RENDER_ID, SAFE_ENTITY_ID } from "@/render/output-paths";
import { LocalAssetStore } from "../assets/asset-store";
import { contentTypeForPath } from "../assets/storage-layout";
import { AuthError, type AuthUser } from "../auth/jwt";
import { apiUserRuntime, type CloudInfra, type UserRuntime } from "../runtime";
import { IDEMPOTENCY_KEY, IdempotencyRepository, requestHash } from "../repos/idempotency-repository";
import { WorkerHeartbeatRepository } from "../repos/worker-heartbeat-repository";
import { corsHeaders, HttpError, match, RateLimiter, readJson, route, sendJson, sendText, type Route } from "./http";

/**
 * Render Web Service (D102). Responde RÁPIDO: valida, autentica, persiste e enfileira.
 * Nunca espera vídeo renderizar; nunca chama provider pago no request (o worker faz).
 * Toda regra de negócio vem de application/ + PipelineService (mesmo código do modo local).
 */

export interface ApiOptions {
  infra: CloudInfra;
  corsOrigins: readonly string[];
  writesPerMinute: number;
  authenticate: (authorization: string | undefined) => Promise<AuthUser>;
  /** Raiz do app (código Remotion) para o diagnóstico do navegador. */
  projectRoot?: string;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  user?: AuthUser;
  body: unknown;
  headers: Record<string, string>;
  runtime(): Promise<UserRuntime>;
}

const UNAVAILABLE = { code: "unavailable", title: "Serviço temporariamente indisponível.", message: "Tente de novo em instantes.", retryable: true } as const;

function statusFor(error: UserError): number {
  switch (error.code) {
    case "validation": case "upload": return 422;
    case "not_found": return 404;
    case "job_in_progress": case "planning_in_progress": case "stale_estimate": case "invalid_state": case "attempt_limit": case "planning_budget": case "over_budget_not_allowed": return 409;
    case "corrupted": case "render_security": return 500;
    default: return 400;
  }
}

const isConnectionError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code ?? "";
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P03", "08006", "08001"].includes(code) || (error instanceof Error && /Connection terminated|connect ECONN/i.test(error.message));
};

export function createApiHandler(options: ApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { infra } = options;
  const limiter = new RateLimiter(options.writesPerMinute);
  const idempotency = new IdempotencyRepository(infra.db);
  const knownProfiles = new Set<string>();
  const ttl = infra.signedUrlTtlSeconds;

  const reply = (ctx: Ctx, status: number, body: unknown) => sendJson(ctx.res, status, body, ctx.headers);
  const result = <T>(ctx: Ctx, r: ActionResult<T>, okStatus = 200) => reply(ctx, r.ok ? okStatus : statusFor(r.error), r);
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(422, "validation", "Os dados enviados são inválidos.");
    return parsed.data;
  };

  /** Executa com Idempotency-Key opcional; replay devolve a mesma resposta sem refazer nada. */
  async function idempotent(ctx: Ctx, scope: string, run: () => Promise<{ status: number; body: unknown }>): Promise<void> {
    const key = ctx.req.headers["idempotency-key"];
    if (typeof key !== "string") { const out = await run(); return reply(ctx, out.status, out.body); }
    if (!IDEMPOTENCY_KEY.test(key)) throw new HttpError(422, "validation", "Idempotency-Key inválida.");
    const started = await idempotency.start(ctx.user!.userId, scope, key, requestHash(ctx.body));
    if (started.kind === "replay") return reply(ctx, started.status, started.body);
    if (started.kind === "mismatch") throw new HttpError(422, "validation", "Esta Idempotency-Key já foi usada com outro pedido.");
    if (started.kind === "in_progress") throw new HttpError(409, "job_in_progress", "Este pedido já está sendo processado.", true);
    try {
      const out = await run();
      await idempotency.complete(ctx.user!.userId, scope, key, out.status, out.body);
      return reply(ctx, out.status, out.body);
    } catch (error) {
      await idempotency.release(ctx.user!.userId, scope, key).catch(() => undefined);
      throw error;
    }
  }

  const routes: Route<Ctx>[] = [
    route("GET", "/health", async (ctx) => sendText(ctx.res, 200, "ok"), { public: true }),
    route("GET", "/ready", async (ctx) => {
      // Sem API paga: só banco, storage e configuração essencial.
      const [database, storage] = await Promise.all([
        infra.db.ping().catch(() => false),
        infra.storage.ping().catch(() => false),
      ]);
      const config = infra.configIssues.length === 0;
      const queue = database ? await infra.queue.counts().catch(() => undefined) : undefined;
      reply(ctx, database && storage && config ? 200 : 503, { ok: database && storage && config, checks: { database, storage, config }, ...(queue ? { queue } : {}) });
    }, { public: true }),

    // ------------------------------------------------------------- local dev: storage assinado por HMAC
    route("GET", "/v1/local-assets/(.+)", async (ctx, params) => localAsset(ctx, params, "read"), { public: true }),
    route("PUT", "/v1/local-assets/(.+)", async (ctx, params) => localAsset(ctx, params, "write"), { public: true }),

    // ------------------------------------------------------------- leitura
    route("GET", "/v1/me", async (ctx) => reply(ctx, 200, { ok: true, value: { userId: ctx.user!.userId } })),
    // L8.1: status do worker para o shell (só estado + último contato; nada do processo).
    route("GET", "/v1/worker", async (ctx) => reply(ctx, 200, { ok: true, value: workerStatusFrom(await new WorkerHeartbeatRepository(infra.db).latest()) })),
    // L8.2: créditos derivados do ledger do usuário (`?summary=1` = só saldo, para o shell).
    route("GET", "/v1/credits", async (ctx) => {
      const view = await loadCreditsView((await ctx.runtime()).deps, infra.config.credits, v2EstimatesFor(infra.config));
      reply(ctx, 200, { ok: true, value: ctx.url.searchParams.get("summary") === "1" ? creditsSummary(view) : view });
    }),
    // L8.8.1: leitura leve do shell (custo constante por poll: fatos em 1 SQL + ledger + avatares).
    route("GET", "/v1/shell", async (ctx) => {
      reply(ctx, 200, { ok: true, value: await buildShellSummary((await ctx.runtime()).deps, infra.config.credits, v2EstimatesFor(infra.config)) });
    }),
    route("GET", "/v1/bootstrap", async (ctx) => {
      const rt = await ctx.runtime();
      const limit = Math.min(Number(ctx.url.searchParams.get("recent") ?? 8) || 8, 100);
      const [avatars, recent] = await Promise.all([listAvatarViews(rt.deps), listProjectCards(rt.deps, limit)]);
      reply(ctx, 200, { ok: true, value: { config: publicConfigFor(infra.config, infra.configIssues, infra.env, options.projectRoot), estimates: v2EstimatesFor(infra.config), avatars, recent } });
    }),
    route("GET", "/v1/settings", async (ctx) => {
      const rt = await ctx.runtime();
      reply(ctx, 200, { ok: true, value: { config: publicConfigFor(infra.config, infra.configIssues, infra.env, options.projectRoot), voices: await listVoiceProfileViews(rt.deps), matrix: rt.deps.service.ugcSpeechMatrix() ?? null, presets: presetSummariesFor(infra.config) } });
    }),
    route("GET", "/v1/projects", async (ctx) => {
      const filter = (ctx.url.searchParams.get("filter") ?? "all") as ProjectFilter;
      const cards = await listProjectCards((await ctx.runtime()).deps);
      reply(ctx, 200, { ok: true, value: cards.filter((c) => matchesFilter(c, ["all", "ready", "in_progress", "attention"].includes(filter) ? filter : "all")) });
    }),
    route("GET", "/v1/projects/:id", async (ctx, { id }) => {
      const view = await getCampaignView((await ctx.runtime()).deps, id!);
      if (!view.ok) return result(ctx, view);
      reply(ctx, 200, { ok: true, value: { view: view.value, v2: view.value.uxVersion === 2 ? buildProjectV2View(view.value) : null } });
    }),
    route("GET", "/v1/jobs/:id", async (ctx, { id }) => {
      // Polling do frontend: status/progresso vêm do BANCO (sobrevive ao navegador fechado).
      const rt = await ctx.runtime();
      const row = (await infra.db.query<{ status: string; progress_stage: string; current_stage: string | null; campaign_id: string; updated_at: Date | string }>(
        "select status, progress_stage, current_stage, campaign_id, updated_at from jobs where id = $1 and user_id = $2", [id, rt.userId])).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Job não encontrado.");
      const task = await infra.queue.latest(rt.userId, jobKey(id!));
      const job = await rt.deps.service.getJob(id!);
      reply(ctx, 200, { ok: true, value: {
        id, campaignId: row.campaign_id, status: row.status, progress: row.progress_stage, currentStage: row.current_stage,
        error: job.error ? job.error.slice(0, 300) : null,
        task: task ? { status: task.status, attempts: task.attempts, blockedReason: task.blockedReason, updatedAt: task.updatedAt } : null,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      } });
    }),
    route("GET", "/v1/avatars", async (ctx) => reply(ctx, 200, { ok: true, value: await listAvatarViews((await ctx.runtime()).deps) })),
    route("GET", "/v1/avatars/:id", async (ctx, { id }) => {
      if (!SAFE_AVATAR_ID.test(id!)) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      const avatar = await getAvatarView((await ctx.runtime()).deps, id!);
      if (!avatar) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      reply(ctx, 200, { ok: true, value: avatar });
    }),
    // L8.7: perfil do avatar (revisões + uso nos projetos do PRÓPRIO usuário). Só leitura.
    route("GET", "/v1/avatars/:id/detail", async (ctx, { id }) => {
      if (!SAFE_AVATAR_ID.test(id!)) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      const detail = await getAvatarDetail((await ctx.runtime()).deps, id!);
      if (!detail) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      reply(ctx, 200, { ok: true, value: detail });
    }),
    route("GET", "/v1/voices", async (ctx) => reply(ctx, 200, { ok: true, value: await listVoiceProfileViews((await ctx.runtime()).deps) })),
    route("GET", "/v1/assets/signed", async (ctx) => {
      const url = await signedAssetUrl(await ctx.runtime(), ctx.url.searchParams);
      if (!url) throw new HttpError(404, "not_found", "Arquivo não encontrado.");
      reply(ctx, 200, { ok: true, value: { url, expiresInSeconds: ttl } });
    }),

    // ------------------------------------------------------------- escrita (respondem rápido; trabalho vai para a fila)
    route("POST", "/v1/projects", async (ctx) => idempotent(ctx, "create_project", async () => {
      const rt = await ctx.runtime();
      const r = await startVideoV2({ ...rt.deps, defaultBudget: infra.config.defaultBudget }, ctx.body);
      return { status: r.ok ? 202 : statusFor(r.error), body: r };
    })),
    route("POST", "/v1/projects/:id/planning", async (ctx, { id }) => {
      const { token } = parse(z.object({ token: z.string().length(64) }), ctx.body);
      result(ctx, await executeHybridPlanning((await ctx.runtime()).deps, { campaignId: id!, token }), 202);
    }),
    route("POST", "/v1/projects/:id/retry-planning", async (ctx, { id }) => result(ctx, await retryCampaignPlanning((await ctx.runtime()).deps, id!), 202)),
    route("POST", "/v1/projects/:id/change-requests", async (ctx, { id }) => {
      const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }), ctx.body);
      const rt = await ctx.runtime();
      try {
        const campaign = await rt.deps.service.getCampaign(id!);
        const jobs = await rt.deps.service.listJobs(campaign.id);
        const quality = campaign.request.quality === "custom" ? "high" : campaign.request.quality;
        const costs = changeRequestCosts(v2EstimatesFor(infra.config), campaign.request.targetDurationSeconds ?? 30, quality, jobs[0]?.voiceLock?.strategy === "locked_voice");
        const parsed = parseChangeRequest(text, costs);
        // Só interpreta e estima; nada é executado nem cobrado.
        await infra.db.query("insert into change_requests (user_id, campaign_id, text, parsed) values ($1, $2, $3, $4::jsonb)", [rt.userId, campaign.id, text, JSON.stringify(parsed)]);
        reply(ctx, 200, { ok: true, value: parsed });
      } catch (error) {
        if ((error as Error).name === "NotFoundError") throw error;
        reply(ctx, 422, { ok: false, error: { code: "validation", title: "Não entendemos o pedido", message: error instanceof Error ? error.message : "Tente descrever de outro jeito.", retryable: true } });
      }
    }),
    route("POST", "/v1/jobs/:id/generate", async (ctx, { id }) => idempotent(ctx, `generate:${id}`, async () => {
      const { token } = parse(z.object({ token: z.string().length(64) }), ctx.body);
      const r = await authorizeAndRunJob((await ctx.runtime()).deps, { jobId: id!, token });
      return { status: r.ok ? 202 : statusFor(r.error), body: r };
    })),
    route("POST", "/v1/jobs/:id/references/:referenceId/approve", async (ctx, { id, referenceId }) => {
      const body = parse(z.object({ fidelityConfirmed: z.boolean(), observedTexts: z.array(z.string().trim().min(1).max(80)).max(20).optional(), confirmedSpecs: z.array(z.string().trim().min(1).max(80)).max(20).optional(), note: z.string().max(300).optional() }), ctx.body);
      result(ctx, await approveUgcReference((await ctx.runtime()).deps, { jobId: id!, referenceId: referenceId!, ...body }), 202);
    }),
    route("POST", "/v1/jobs/:id/references/regenerate", async (ctx, { id }) => {
      const body = parse(z.object({ fidelityRejection: z.object({ observedTexts: z.array(z.string().trim().min(1).max(80)).max(20).optional(), note: z.string().max(300).optional() }).optional() }), ctx.body);
      result(ctx, await regenerateUgcReference((await ctx.runtime()).deps, { jobId: id!, ...body }), 202);
    }),
    route("POST", "/v1/jobs/:id/scenes/:sceneId/retry", async (ctx, { id, sceneId }) => {
      const body = parse(z.object({ token: z.string().length(64) }), ctx.body);
      result(ctx, await retryFailedScene((await ctx.runtime()).deps, { jobId: id!, sceneId: sceneId!, token: body.token }), 202);
    }),
    // Regeneração voluntária de cena PRONTA; só o token vem do cliente, o recipe é derivado no servidor.
    route("POST", "/v1/jobs/:id/scenes/:sceneId/regenerate", async (ctx, { id, sceneId }) => {
      const body = parse(z.object({ token: z.string().length(64) }), ctx.body);
      result(ctx, await regenerateStoryboardScene((await ctx.runtime()).deps, { jobId: id!, sceneId: sceneId!, token: body.token }), 202);
    }),
    // Retry SEM custo (render/retomada segura). Retry pago passa por /generate com nova cotação aprovada.
    route("POST", "/v1/jobs/:id/retry", async (ctx, { id }) => result(ctx, await rerenderCreative((await ctx.runtime()).deps, id!), 202)),
    route("POST", "/v1/jobs/:id/cancel", async (ctx, { id }) => result(ctx, await cancelCreative((await ctx.runtime()).deps, id!))),

    route("POST", "/v1/avatars", async (ctx) => {
      if (typeof ctx.body !== "object" || ctx.body === null) throw new HttpError(422, "validation", "Os dados enviados são inválidos.");
      result(ctx, await saveAvatar((await ctx.runtime()).deps, ctx.body as Record<string, unknown>));
    }),
    route("POST", "/v1/avatars/:id/active", async (ctx, { id }) => {
      const { active } = parse(z.object({ active: z.boolean() }), ctx.body);
      if (!SAFE_AVATAR_ID.test(id!)) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      result(ctx, await setAvatarActive((await ctx.runtime()).deps, id!, active));
    }),
    route("DELETE", "/v1/avatars/:id", async (ctx, { id }) => {
      if (!SAFE_AVATAR_ID.test(id!)) throw new HttpError(404, "not_found", "Avatar não encontrado.");
      result(ctx, await archiveAvatar((await ctx.runtime()).deps, id!));
    }),
    route("POST", "/v1/voices", async (ctx) => result(ctx, await saveVoiceProfile((await ctx.runtime()).deps, ctx.body))),

    // ------------------------------------------------------------- upload direto ao Storage
    route("POST", "/v1/uploads/authorize", async (ctx) => {
      const body = parse(z.object({ ownerId: z.string().regex(SAFE_PRODUCT_ID), contentType: z.string().max(40), size: z.number().int().positive() }), ctx.body);
      try {
        const out = await (await ctx.runtime()).deps.uploads.authorize(body.ownerId, { declaredType: body.contentType, size: body.size });
        reply(ctx, 201, { ok: true, value: { imageId: out.imageId, uploadUrl: out.upload.url, expiresInSeconds: out.upload.expiresInSeconds } });
      } catch (error) {
        reply(ctx, 422, { ok: false, error: toUserError(error) });
      }
    }),
    route("POST", "/v1/uploads/complete", async (ctx) => {
      const body = parse(z.object({ ownerId: z.string().regex(SAFE_PRODUCT_ID), imageId: z.string().regex(STORED_IMAGE_NAME) }), ctx.body);
      try {
        const uploads = (await ctx.runtime()).deps.uploads;
        const stored = await uploads.complete(body.ownerId, body.imageId);
        reply(ctx, 201, { ok: true, value: { productId: body.ownerId, id: stored.id, previewUrl: imagePreviewUrl(body.ownerId, stored.id) ?? "", size: stored.size } });
      } catch (error) {
        reply(ctx, 422, { ok: false, error: toUserError(error) });
      }
    }),
    route("DELETE", "/v1/uploads/:ownerId/:imageId", async (ctx, { ownerId, imageId }) => {
      if (!SAFE_PRODUCT_ID.test(ownerId!) || !STORED_IMAGE_NAME.test(imageId!)) throw new HttpError(404, "not_found", "Imagem não encontrada.");
      reply(ctx, 200, { ok: true, value: { removed: await (await ctx.runtime()).deps.uploads.remove(ownerId!, imageId!) } });
    }),
  ];

  async function localAsset(ctx: Ctx, params: Record<string, string>, op: "read" | "write"): Promise<void> {
    if (!(infra.storage instanceof LocalAssetStore)) throw new HttpError(404, "not_found", "Não encontrado.");
    const path = ctx.url.pathname.slice("/v1/local-assets/".length);
    void params;
    if (!infra.storage.verify(path, ctx.url.searchParams.get("exp"), ctx.url.searchParams.get("sig"), op)) throw new HttpError(403, "validation", "Link expirado ou inválido.");
    if (op === "read") {
      const data = await infra.storage.get(path);
      if (!data) throw new HttpError(404, "not_found", "Não encontrado.");
      ctx.res.writeHead(200, { "Content-Type": (await infra.storage.contentType(path)) ?? contentTypeForPath(path), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...ctx.headers });
      ctx.res.end(Buffer.from(data));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of ctx.req) { size += (chunk as Buffer).length; if (size > 8 * 1024 * 1024 + 1024) throw new HttpError(413, "upload", "Arquivo grande demais."); chunks.push(chunk as Buffer); }
    await infra.storage.put(path, new Uint8Array(Buffer.concat(chunks)), { contentType: String(ctx.req.headers["content-type"] ?? "application/octet-stream").slice(0, 60), upsert: true });
    sendJson(ctx.res, 200, { ok: true }, ctx.headers);
  }

  /** URL assinada sob demanda, SÓ para arquivo registrado no job do próprio usuário. */
  async function signedAssetUrl(rt: UserRuntime, q: URLSearchParams): Promise<string | undefined> {
    const kind = q.get("kind");
    const get = (k: string) => q.get(k) ?? "";
    if (kind === "upload") {
      if (!SAFE_PRODUCT_ID.test(get("ownerId")) || !STORED_IMAGE_NAME.test(get("imageId"))) return undefined;
      return rt.deps.uploads.signedUrl(get("ownerId"), get("imageId"), ttl);
    }
    const campaignId = get("campaignId"), creativeId = get("creativeId");
    if (!SAFE_ENTITY_ID.test(campaignId) || !SAFE_ENTITY_ID.test(creativeId)) return undefined;
    const jobs = await rt.deps.service.listJobs(campaignId).catch(() => []);
    const job = jobs.find((j) => j.creativeId === creativeId);
    if (!job) return undefined;
    let uri: string | undefined;
    let downloadName: string | undefined;
    const version = get("version");
    if (kind === "render" && RENDER_ID.test(get("renderId"))) {
      const record = job.renders.find((r) => r.renderId === get("renderId") && r.status === "completed" && !r.isMock);
      uri = record ? `${infra.config.rendersDir.replaceAll("\\", "/").replace(/\/+$/, "")}/${campaignId}/${creativeId}/${get("renderId")}/${FINAL_FILE}` : undefined;
      if (q.get("download") === "1") downloadName = `criativo-${creativeId}-${get("renderId")}.mp4`;
    } else if (kind === "reference" && RENDER_ID.test(version)) {
      uri = job.ugc?.references.find((r) => r.state === "succeeded" && !r.isMock && r.version === version)?.imageUri;
    } else if (kind === "clip" && SAFE_ENTITY_ID.test(get("sceneId")) && RENDER_ID.test(version)) {
      uri = job.scenes.find((s) => s.sceneId === get("sceneId"))?.attempts.find((a) => a.status === "succeeded" && !a.isMock && a.assetUri?.replaceAll("\\", "/").endsWith(`/${get("sceneId")}/${version}/clip.mp4`))?.assetUri;
    } else if (kind === "audio" && RENDER_ID.test(version)) {
      uri = job.audioAttempts.find((a) => a.status === "succeeded" && !a.isMock && a.narration?.version === version)?.assetUri;
    }
    if (!uri) return undefined;
    const row = await rt.assets.findGenerated(campaignId, uri);
    return row ? infra.storage.getSignedUrl(row.path, { expiresInSeconds: ttl, ...(downloadName ? { downloadName } : {}) }) : undefined;
  }

  return async function handle(req, res) {
    const requestId = /^[A-Za-z0-9-]{8,64}$/.test(String(req.headers["x-request-id"] ?? "")) ? String(req.headers["x-request-id"]) : randomUUID();
    const url = new URL(req.url ?? "/", "http://api.local");
    const cors = corsHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined, options.corsOrigins);
    const headers = { "X-Request-Id": requestId, ...(cors ?? {}) };
    const log = infra.logger.child({ requestId });
    const started = Date.now();
    let runtime: Promise<UserRuntime> | undefined;
    const ctx: Ctx = { req, res, url, requestId, body: undefined, headers, runtime: () => (runtime ??= apiUserRuntime(infra, ctx.user!.userId)) };
    try {
      if (req.headers.origin && !cors) throw new HttpError(403, "validation", "Origem não permitida.");
      if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
      const found = match(routes, req.method ?? "GET", url.pathname);
      if (found === "method_not_allowed") throw new HttpError(405, "validation", "Método não permitido.");
      if (!found) throw new HttpError(404, "not_found", "Não encontrado.");
      if (!found.route.public) {
        try {
          ctx.user = await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
        } catch (error) {
          throw new HttpError(401, "auth", error instanceof AuthError ? error.message : "Faça login para continuar.");
        }
        if (found.route.write && !limiter.allow(ctx.user.userId)) throw new HttpError(429, "rate_limited", "Muitas ações seguidas. Aguarde um minuto.", true);
        if (!knownProfiles.has(ctx.user.userId)) {
          try {
            await infra.db.query("insert into profiles (user_id) values ($1) on conflict (user_id) do nothing", [ctx.user.userId]);
          } catch (error) {
            // 23503 = usuário da sessão não existe em auth.users DESTE banco: SUPABASE_URL (login) e
            // DATABASE_URL apontam para projetos Supabase diferentes. Falha clara, nunca "erro inesperado".
            if ((error as { code?: string } | null)?.code === "23503") {
              log.error("sessão de outro projeto Supabase", { userId: ctx.user.userId });
              throw new HttpError(500, "config", "Configuração da API: o login e o banco usam projetos Supabase diferentes (SUPABASE_URL × DATABASE_URL).");
            }
            throw error;
          }
          knownProfiles.add(ctx.user.userId);
        }
        ctx.body = found.route.write && !url.pathname.startsWith("/v1/local-assets/") ? await readJson(req) : undefined;
      }
      await found.route.handler(ctx, found.params);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: { code: error.code, title: error.status === 401 ? "Sessão necessária" : "Não foi possível concluir", message: error.message, retryable: error.retryable } }, headers);
      } else if (isConnectionError(error)) {
        log.error("dependência indisponível", { error });
        sendJson(res, 503, { ok: false, error: UNAVAILABLE }, headers);
      } else {
        const userError = toUserError(error);
        const status = userError.code === "provider_error" ? 500 : statusFor(userError);
        if (status >= 500) log.error("falha não tratada", { error, path: url.pathname });
        // Mensagem já sanitizada por toUserError (sem stack, sem SQL, sem URL interna).
        sendJson(res, status, { ok: false, error: status >= 500 ? { code: "internal", title: "Não foi possível concluir agora.", message: "Tente de novo em instantes.", retryable: true } : userError }, headers);
      }
    } finally {
      log.info("request", { method: req.method, path: url.pathname.startsWith("/v1/local-assets/") ? "/v1/local-assets/…" : url.pathname, status: res.statusCode, ms: Date.now() - started, userId: ctx.user?.userId });
    }
  };
}

