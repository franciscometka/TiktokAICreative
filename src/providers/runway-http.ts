import { z } from "zod";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import { ProviderError } from "./types";
export const TaskSchema = z.object({
  id: z.string().min(1), status: z.enum(["PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
  output: z.array(z.string().url()).optional(), cost: z.object({ credits: z.number().nonnegative() }).optional(),
  duration: z.number().positive().optional(),
});
/** Shared HTTP only; providers keep their own media contracts. No retries. */
export class RunwayHttpClient {
  #key: string;
  lastDiagnostic?: ProviderDiagnostic;
  readonly diagnostics = new Map<string, ProviderDiagnostic>();
  constructor(apiKey: string, private readonly transport: typeof fetch = fetch) {
    if (!apiKey) throw new ProviderError("RUNWAYML_API_SECRET não configurada");
    this.#key = apiKey;
  }
  /** Seleciona somente campos diagnósticos; nunca inclui body, payload ou erro bruto. */
  clean(value: unknown, sensitive: string[] = []): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    let text = String(value);
    // Redige antes de truncar, inclusive mensagens que ecoam chave, prompt ou imagem.
    for (const secret of [this.#key, ...sensitive]) {
      if (secret) {
        for (const variant of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) text = text.split(variant).join("[redigido]");
      }
    }
    text = text.replace(/data:[^\s"'<>]+/gi, "[imagem redigida]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redigida]")
      .replace(/(?:authorization|bearer|api[_ -]?key|promptImage|promptText|payload)[^\r\n]*/gi, "[campo redigido]")
      .replace(/[\x00-\x1f\x7f]/g, " ");
    return text.slice(0, 500) || undefined;
  }
  failure(diagnostic: ProviderDiagnostic, id?: string): ProviderError {
    const labels: Record<ProviderDiagnostic["kind"], string> = {
      invalid_request: "requisição inválida", authentication: "autenticação/permissão",
      quota: "crédito/quota/rate limit", provider: "erro do provider", http: "erro HTTP",
      timeout: "timeout", connection: "erro de conexão", invalid_response: "resposta inválida",
    };
    const details = [diagnostic.httpStatus && `HTTP ${diagnostic.httpStatus}`,
      diagnostic.requestId && `request-id ${diagnostic.requestId}`,
      diagnostic.providerCode && `código ${diagnostic.providerCode}`,
      diagnostic.providerStatus && `status ${diagnostic.providerStatus}`, diagnostic.providerMessage].filter(Boolean).join("; ");
    return new ProviderError(`Runway: ${labels[diagnostic.kind]}${details ? ` (${details})` : ""}. ${diagnostic.billing === "rejected" ? "Criação rejeitada pelo HTTP; sem tarefa confirmada." : diagnostic.billing === "confirmed" ? "Consumo informado pelo provider." : "Possível cobrança não confirmada."} Sem retry automático.`, id, undefined, diagnostic);
  }
  async api(path: string, init: RequestInit = {}, id?: string): Promise<unknown> {
    const creating = init.method === "POST";
    const sensitive: string[] = [];
    if (typeof init.body === "string") {
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      const collect = (value: unknown): void => {
        if (typeof value === "string") { sensitive.push(value); if (value.startsWith("data:")) sensitive.push(value.split(",")[1] ?? ""); }
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(payload);
    }
    let response: Response | undefined;
    let diagnostic: ProviderDiagnostic = { kind: "connection", billing: "unconfirmed" };
    try {
      response = await this.transport(`https://api.dev.runwayml.com/v1${path}`, {
        ...init, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${this.#key}`, "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" },
      });
      const status = response.status;
      // 4xx explícito na criação rejeita o pedido. 408/5xx podem vir após aceitação.
      const rejected = creating && status >= 400 && status < 500 && status !== 408;
      diagnostic = {
        kind: status === 400 || status === 422 ? "invalid_request" : status === 401 || status === 403 ? "authentication" :
          status === 402 || status === 429 ? "quota" : status >= 500 ? "provider" : "http",
        httpStatus: status,
        requestId: this.clean(response.headers.get("request-id") ?? response.headers.get("x-request-id"), sensitive)?.slice(0, 200),
        billing: rejected ? "rejected" : "unconfirmed",
      };
      let body: unknown;
      try { body = await response.json(); }
      catch (error) {
        if (!response.ok) throw this.failure(diagnostic, id);
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
        throw this.failure({ ...diagnostic, kind: error instanceof SyntaxError ? "invalid_response" : "connection" }, id);
      }
      const obj = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const nested = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
      diagnostic = { ...diagnostic,
        providerCode: this.clean(obj.code ?? nested.code ?? obj.failureCode, sensitive),
        providerStatus: this.clean(obj.status ?? nested.status, sensitive),
        providerMessage: this.clean(obj.message ?? nested.message ?? (typeof obj.error === "string" ? obj.error : obj.failure), sensitive),
      };
      if (typeof obj.id === "string" && obj.id.length > 0) diagnostic.billing = "unconfirmed";
      if (!response.ok) throw this.failure(diagnostic, id);
      // Validação dentro do escopo da resposta mantém HTTP e request-id em erros de schema.
      const valid = creating ? z.object({ id: z.string().min(1).max(256) }).safeParse(body).success :
        TaskSchema.safeParse(body).success && obj.id === id;
      if (!valid) throw this.failure({ ...diagnostic, kind: "invalid_response" }, id);
      this.lastDiagnostic = diagnostic;
      if (!creating && id) this.diagnostics.set(id, diagnostic);
      return body;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw this.failure({ ...diagnostic, kind: timeout ? "timeout" : "connection" }, id);
    }
  }
}
