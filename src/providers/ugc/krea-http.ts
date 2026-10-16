import { assertRealCallsEnabled } from "@/config/execution-policy";
import { KREA_API_BASE } from "@/config/krea-ugc-models";
import type { Usage } from "@/costs/calculate";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import { ProviderError } from "../types";

/** Resultados da Krea vêm de `gen.krea.ai`; só HTTPS em hosts *.krea.ai é baixado, sem a chave. */
const DOWNLOAD_HOSTS = [/(^|\.)krea\.ai$/];
export const KREA_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
/** `POST /assets` aceita até 75 MB; mantemos um teto menor para fotos de referência. */
export const KREA_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type KreaUgcPhase = "rejected_before_job" | "failed_after_job" | "uncertain";

/** Estados oficiais de `GET /jobs/{id}` (OpenAPI). */
export const KREA_JOB_STATES = ["backlogged", "queued", "scheduled", "processing", "sampling", "intermediate-complete", "completed", "failed", "cancelled"] as const;
export type KreaJobState = (typeof KREA_JOB_STATES)[number];

export interface KreaJob {
  jobId: string;
  status: KreaJobState;
  urls: string[];
  errorCode?: string;
  errorMessage?: string;
  progress?: number;
}

/**
 * Erro tipado e SANITIZADO da Krea. A mensagem nunca contém chave, prompt, base64 ou URL.
 * rejected_before_job: HTTP 4xx na criação → sem job, sem cobrança.
 * failed_after_job: o job existiu e falhou depois → pode haver cobrança.
 * uncertain: timeout/rede/5xx após envio → incerto; NUNCA reenviar automaticamente.
 */
export class KreaUgcError extends ProviderError {
  override name = "KreaUgcError";
  constructor(message: string, readonly phase: KreaUgcPhase, diagnostic: ProviderDiagnostic, providerJobId?: string, billedUsage?: Usage) {
    super(message, providerJobId, billedUsage, diagnostic);
  }
}

const LABELS: Record<ProviderDiagnostic["kind"], string> = {
  invalid_request: "requisição inválida", authentication: "autenticação/permissão", quota: "saldo/quota/rate limit",
  provider: "erro do provider", http: "erro HTTP", timeout: "timeout", connection: "erro de conexão", invalid_response: "resposta inválida",
};

const JOB_ID = /^[\w-]{8,128}$/;

/** HTTP mínimo da Krea API: Bearer em campo privado, sem retry, timeout por request, redação. */
export class KreaHttpClient {
  #key: string;
  private readonly transport: typeof fetch;
  private readonly injected: boolean;
  constructor(apiKey: string, transport?: typeof fetch, private readonly timeoutMs = 60_000) {
    if (!apiKey) throw new ProviderError("KREA_API_KEY não configurada no servidor.");
    this.#key = apiKey;
    this.transport = transport ?? fetch;
    this.injected = transport !== undefined;
  }

  /** Redige segredo, base64, URLs e controle antes de truncar. */
  clean(value: unknown, sensitive: readonly string[] = []): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    let text = String(value);
    for (const secret of [this.#key, ...sensitive]) {
      if (secret && secret.length >= 4) for (const variant of [secret, encodeURIComponent(secret)]) text = text.split(variant).join("[redigido]");
    }
    text = text.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redigida]")
      .replace(/[A-Za-z0-9+/=]{200,}/g, "[dados redigidos]")
      .replace(/(?:authorization|bearer|api[_ -]?key)[^\r\n]*/gi, "[campo redigido]")
      .replace(/[\x00-\x1f\x7f]/g, " ");
    return text.slice(0, 500) || undefined;
  }

  error(diagnostic: ProviderDiagnostic, phase: KreaUgcPhase, jobId?: string, billedUsage?: Usage): KreaUgcError {
    const details = [diagnostic.httpStatus && `HTTP ${diagnostic.httpStatus}`, diagnostic.requestId && `request-id ${diagnostic.requestId}`,
      diagnostic.providerCode && `código ${diagnostic.providerCode}`, jobId && `job ${this.clean(jobId)}`, diagnostic.providerMessage].filter(Boolean).join("; ");
    const tail = phase === "rejected_before_job" ? "Rejeitado antes de criar job; sem cobrança confirmada."
      : phase === "failed_after_job" ? "O job existiu e falhou: pode haver cobrança."
      : "Resultado incerto: pode ter sido aceito/cobrado.";
    return new KreaUgcError(`Krea AI UGC: ${LABELS[diagnostic.kind]}${details ? ` (${details})` : ""}. ${tail} Sem retry automático.`, phase,
      { ...diagnostic, operation: phase === "rejected_before_job" ? "none" : phase === "failed_after_job" ? "created" : "unknown",
        billing: phase === "rejected_before_job" ? "rejected" : billedUsage ? "confirmed" : "unconfirmed" }, jobId, billedUsage);
  }

  private diagnostic(response: Response, obj: Record<string, unknown>, sensitive: readonly string[]): ProviderDiagnostic {
    const status = response.status;
    const nested = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
    return {
      kind: status === 400 || status === 404 || status === 422 ? "invalid_request" : status === 401 || status === 403 ? "authentication"
        : status === 402 || status === 429 ? "quota" : status >= 500 ? "provider" : "http",
      httpStatus: status,
      requestId: this.clean(response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 200),
      billing: "unconfirmed",
      providerCode: this.clean(nested.code ?? obj.code, sensitive),
      providerMessage: this.clean(nested.message ?? obj.message ?? (typeof obj.error === "string" ? obj.error : undefined), sensitive),
    };
  }

  private async send(path: string, init: RequestInit, paid: boolean, jobId?: string, sensitive: readonly string[] = []): Promise<{ obj: Record<string, unknown>; response: Response }> {
    if (!this.injected) assertRealCallsEnabled(paid);
    let response: Response;
    try {
      response = await this.transport(`${KREA_API_BASE}${path}`, {
        ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.#key}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      // Sem resposta: na criação o job pode ter sido aceito (incerto); no polling, retomável pelo ID.
      throw this.error({ kind: timeout ? "timeout" : "connection", billing: "unconfirmed" }, "uncertain", jobId);
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    if (!response.ok) {
      // 4xx explícito (exceto 408) na criação paga = rejeitado antes de existir job.
      const rejected = paid && response.status >= 400 && response.status < 500 && response.status !== 408;
      throw this.error(this.diagnostic(response, obj, sensitive), rejected ? "rejected_before_job" : "uncertain", jobId);
    }
    if (parsed === undefined) throw this.error({ ...this.diagnostic(response, obj, sensitive), kind: "invalid_response" }, "uncertain", jobId);
    return { obj, response };
  }

  /** Upload de referência (`POST /assets`, multipart). Não é geração paga; devolve a URL hospedada. */
  async uploadAsset(data: Uint8Array, mimeType: string, name: string): Promise<string> {
    if (data.byteLength === 0 || data.byteLength > KREA_MAX_UPLOAD_BYTES) throw new ProviderError("Krea: imagem de referência vazia ou maior que 20 MB; reduza a foto.");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), name);
    const { obj, response } = await this.send("/assets", { method: "POST", body: form }, false);
    const url = obj.image_url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw this.error({ ...this.diagnostic(response, obj, []), kind: "invalid_response" }, "rejected_before_job");
    return url;
  }

  /** Criação PAGA de um job (`POST /generate/...`). Consome a autorização efêmera da etapa. */
  async createJob(path: string, body: Record<string, unknown>, sensitive: readonly string[]): Promise<{ jobId: string; requestId?: string }> {
    const { obj, response } = await this.send(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, true, undefined, [...sensitive, ...Object.values(body).filter((v): v is string => typeof v === "string")]);
    const jobId = obj.job_id;
    // 200 sem job_id: pode ter sido aceito → incerto, sem reenvio.
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw this.error({ ...this.diagnostic(response, obj, sensitive), kind: "invalid_response" }, "uncertain");
    return { jobId, requestId: this.diagnostic(response, obj, sensitive).requestId };
  }

  /** Polling (`GET /jobs/{id}`): gratuito, só depende do ID — funciona após restart. */
  async getJob(jobId: string): Promise<KreaJob> {
    if (!JOB_ID.test(jobId)) throw new ProviderError("Job ID da Krea inválido.");
    const { obj } = await this.send(`/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, false, jobId);
    const status = obj.status;
    if (typeof status !== "string" || !(KREA_JOB_STATES as readonly string[]).includes(status)) {
      throw this.error({ kind: "invalid_response", billing: "unconfirmed" }, "uncertain", jobId);
    }
    const result = (obj.result ?? {}) as { urls?: unknown };
    const raw = result.urls;
    const urls = Array.isArray(raw)
      ? raw.map(item => (typeof item === "string" ? item : item && typeof item === "object" ? (item as { url?: unknown }).url : undefined)).filter((u): u is string => typeof u === "string")
      : raw && typeof raw === "object" ? Object.values(raw).filter((u): u is string => typeof u === "string") : [];
    const error = (obj.error ?? {}) as { code?: unknown; message?: unknown };
    return {
      jobId, status: status as KreaJobState, urls,
      ...(this.clean(error.code) ? { errorCode: this.clean(error.code) } : {}),
      ...(this.clean(error.message) ? { errorMessage: this.clean(error.message) } : {}),
      ...(typeof obj.progress === "number" ? { progress: obj.progress } : {}),
    };
  }

  /** Download do resultado: só HTTPS em *.krea.ai, SEM a chave, sem redirect, com limite de tamanho. */
  async download(url: string, jobId: string): Promise<Uint8Array> {
    if (!this.injected) assertRealCallsEnabled(false);
    const allowed = (() => { try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && DOWNLOAD_HOSTS.some(h => h.test(u.hostname)); } catch { return false; } })();
    if (!allowed) throw this.error({ kind: "invalid_response", billing: "unconfirmed" }, "failed_after_job", jobId);
    let response: Response;
    try {
      response = await this.transport(url, { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs * 2) });
    } catch {
      // O job já concluiu (provavelmente cobrado); o ID permite baixar de novo sem novo POST.
      throw this.error({ kind: "connection", billing: "unconfirmed" }, "uncertain", jobId);
    }
    if (!response.ok) throw this.error({ kind: "http", httpStatus: response.status, billing: "unconfirmed" }, "uncertain", jobId);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > KREA_MAX_DOWNLOAD_BYTES) throw this.error({ kind: "invalid_response", httpStatus: response.status, billing: "unconfirmed" }, "failed_after_job", jobId);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > KREA_MAX_DOWNLOAD_BYTES) throw this.error({ kind: "invalid_response", httpStatus: response.status, billing: "unconfirmed" }, "failed_after_job", jobId);
    return data;
  }
}
