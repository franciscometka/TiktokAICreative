import { assertRealCallsEnabled } from "@/config/execution-policy";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import type { Usage } from "@/costs/calculate";
import { ProviderError } from "../types";

/** Base oficial da Gemini API. Nunca automação do Flow/web UI. */
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DOWNLOAD_HOSTS = [/^generativelanguage\.googleapis\.com$/, /^storage\.googleapis\.com$/, /(^|\.)googleusercontent\.com$/];
export const GOOGLE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export type GoogleUgcPhase = "rejected_before_operation" | "failed_after_operation" | "uncertain";

/**
 * Erro tipado e SANITIZADO do AI UGC Google. A mensagem nunca contém chave, prompt, base64 ou URL.
 * A) rejected_before_operation: HTTP 4xx na criação → sem operação, sem cobrança.
 * B) failed_after_operation: operação/resposta existiu e falhou depois → pode haver cobrança.
 * C) uncertain: timeout/rede/5xx após envio → incerto; NUNCA reenviar automaticamente.
 */
export class GoogleUgcError extends ProviderError {
  override name = "GoogleUgcError";
  constructor(message: string, readonly phase: GoogleUgcPhase, diagnostic: ProviderDiagnostic, providerJobId?: string, billedUsage?: Usage) {
    super(message, providerJobId, billedUsage, diagnostic);
  }
}

const LABELS: Record<ProviderDiagnostic["kind"], string> = {
  invalid_request: "requisição inválida", authentication: "autenticação/permissão", quota: "quota/rate limit",
  provider: "erro do provider", http: "erro HTTP", timeout: "timeout", connection: "erro de conexão", invalid_response: "resposta inválida",
};

/** HTTP mínimo da Gemini API: chave em campo privado, sem retry, timeout por request, redação. */
export class GoogleAiHttpClient {
  #key: string;
  private readonly transport: typeof fetch;
  private readonly injected: boolean;
  constructor(apiKey: string, transport?: typeof fetch, private readonly timeoutMs = 60_000) {
    if (!apiKey) throw new ProviderError("GOOGLE_AI_API_KEY não configurada no servidor.");
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
      .replace(/(?:x-goog-api-key|api[_ -]?key|authorization|bearer|inlineData|inline_data)[^\r\n]*/gi, "[campo redigido]")
      .replace(/[\x00-\x1f\x7f]/g, " ");
    return text.slice(0, 500) || undefined;
  }

  error(diagnostic: ProviderDiagnostic, phase: GoogleUgcPhase, operationId?: string, billedUsage?: Usage): GoogleUgcError {
    const details = [diagnostic.httpStatus && `HTTP ${diagnostic.httpStatus}`, diagnostic.requestId && `request-id ${diagnostic.requestId}`,
      diagnostic.providerCode && `código ${diagnostic.providerCode}`, operationId && `operação ${this.clean(operationId)}`, diagnostic.providerMessage].filter(Boolean).join("; ");
    const tail = phase === "rejected_before_operation" ? "Rejeitado antes de criar operação; sem cobrança confirmada."
      : phase === "failed_after_operation" ? "A operação existiu e falhou: pode haver cobrança."
      : "Resultado incerto: pode ter sido aceito/cobrado.";
    return new GoogleUgcError(`Google AI UGC: ${LABELS[diagnostic.kind]}${details ? ` (${details})` : ""}. ${tail} Sem retry automático.`, phase,
      { ...diagnostic, operation: phase === "rejected_before_operation" ? "none" : phase === "failed_after_operation" ? "created" : "unknown",
        billing: phase === "rejected_before_operation" ? "rejected" : billedUsage ? "confirmed" : "unconfirmed" }, operationId, billedUsage);
  }

  /** POST cria (paga) e consome a autorização efêmera; GET (polling) não. */
  async json(method: "GET" | "POST", path: string, body?: unknown, operationId?: string): Promise<{ body: Record<string, unknown>; requestId?: string }> {
    const creating = method === "POST";
    if (!this.injected) assertRealCallsEnabled(creating);
    const sensitive: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string" && value.length >= 8) sensitive.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(body);
    let diagnostic: ProviderDiagnostic = { kind: "connection", billing: "unconfirmed" };
    let response: Response;
    try {
      response = await this.transport(`${GEMINI_API_BASE}/${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "x-goog-api-key": this.#key, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      // Sem resposta: na criação, o pedido pode ter sido aceito (incerto); no polling, retomável pelo ID.
      throw this.error({ ...diagnostic, kind: timeout ? "timeout" : "connection" }, "uncertain", operationId);
    }
    const status = response.status;
    const requestId = this.clean(response.headers.get("x-request-id") ?? response.headers.get("x-goog-request-id"))?.slice(0, 200);
    diagnostic = {
      kind: status === 400 || status === 404 || status === 422 ? "invalid_request" : status === 401 || status === 403 ? "authentication"
        : status === 429 ? "quota" : status >= 500 ? "provider" : "http",
      httpStatus: status, requestId, billing: "unconfirmed",
    };
    let parsed: unknown;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const nested = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
    diagnostic = { ...diagnostic, providerCode: this.clean(nested.status ?? nested.code, sensitive), providerMessage: this.clean(nested.message, sensitive) };
    if (!response.ok) {
      // 4xx explícito (exceto 408) na criação = rejeitado antes de existir operação.
      const rejected = creating && status >= 400 && status < 500 && status !== 408;
      throw this.error(diagnostic, rejected ? "rejected_before_operation" : "uncertain", operationId);
    }
    if (parsed === undefined) throw this.error({ ...diagnostic, kind: "invalid_response" }, "uncertain", operationId);
    return { body: obj, requestId };
  }

  /** Download do asset: só HTTPS em hosts Google; redirect manual SEM a chave; limite de tamanho. */
  async download(uri: string, operationId: string): Promise<Uint8Array> {
    if (!this.injected) assertRealCallsEnabled(false);
    const fail = (kind: ProviderDiagnostic["kind"], httpStatus?: number) => this.error({ kind, httpStatus, billing: "unconfirmed" }, "failed_after_operation", operationId);
    const allowed = (value: string) => { try { const url = new URL(value); return url.protocol === "https:" && DOWNLOAD_HOSTS.some(host => host.test(url.hostname)); } catch { return false; } };
    if (!allowed(uri)) throw fail("invalid_response");
    let response: Response;
    try {
      const sameApi = new URL(uri).hostname === "generativelanguage.googleapis.com";
      response = await this.transport(uri, { redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs * 2), headers: sameApi ? { "x-goog-api-key": this.#key } : {} });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || !allowed(location)) throw fail("invalid_response", response.status);
        response = await this.transport(location, { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs * 2) });
      }
    } catch (error) {
      if (error instanceof GoogleUgcError) throw error;
      // Download falhou: a operação já concluiu (cobrada); o ID permite tentar baixar de novo sem novo POST.
      throw this.error({ kind: "connection", billing: "unconfirmed" }, "uncertain", operationId);
    }
    // HTTP falho no download não prova falha da geração: fica retomável pelo ID, sem novo POST.
    if (!response.ok) throw this.error({ kind: "http", httpStatus: response.status, billing: "unconfirmed" }, "uncertain", operationId);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > GOOGLE_MAX_DOWNLOAD_BYTES) throw fail("invalid_response", response.status);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > GOOGLE_MAX_DOWNLOAD_BYTES) throw fail("invalid_response", response.status);
    return data;
  }
}
