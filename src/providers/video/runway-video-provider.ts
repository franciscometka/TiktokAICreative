import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import { isMp4 } from "./mp4";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RUNWAY_VIDEO, runwayDuration } from "@/config/video-models";
import { RUNWAY_CREDITS_PER_SECOND } from "@/config/pricing";
import { costForUsage, type Usage } from "@/costs/calculate";
import type { ProviderPricing } from "@/domain/cost";
import { AssetResolver } from "@/render/asset-resolver";
import { ProviderError, type MediaResult, type ProviderJobRef, type ProviderJobStatus } from "../types";
import type { VideoGenerationRequest, VideoProvider } from "./video-provider";

const TaskSchema = z.object({
  id: z.string().min(1), status: z.enum(["PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
  output: z.array(z.string().url()).optional(), cost: z.object({ credits: z.number().nonnegative() }).optional(),
});
export interface RunwayOptions {
  pricing: ProviderPricing;
  apiKey: string;
  uploadsDir: string;
  transport?: typeof fetch;
}
/** HTTP isolado, sem SDK/retry. URLs temporárias nunca entram no job ou manifest. */
export class RunwayVideoProvider implements VideoProvider {
  readonly descriptor;
  #key: string;
  private readonly transport: typeof fetch;
  private readonly jobs = new Map<string, { seconds: number; output?: string; usage?: Usage }>();
  private readonly diagnostics = new Map<string, ProviderDiagnostic>();
  private readonly pricing: ProviderPricing;
  private readonly uploadsDir: string;
  constructor(options: RunwayOptions) {
    this.pricing = options.pricing;
    this.uploadsDir = options.uploadsDir;
    if (!options.apiKey) throw new ProviderError("RUNWAYML_API_SECRET não configurada");
    if (options.pricing.provider !== RUNWAY_VIDEO.provider || options.pricing.model !== RUNWAY_VIDEO.model) {
      throw new ProviderError("O plano usa outro modelo de vídeo. Crie uma nova campanha com Runway e aprove a nova estimativa.");
    }
    this.#key = options.apiKey;
    this.transport = options.transport ?? fetch;
    this.descriptor = { id: RUNWAY_VIDEO.provider, model: RUNWAY_VIDEO.model, isMock: false, pricing: options.pricing };
  }
  estimateCost(request: VideoGenerationRequest) {
    const cost = costForUsage(this.pricing, { seconds: runwayDuration(request.durationSeconds) });
    return { kind: "estimate" as const, ...cost, pricing: this.pricing };
  }
  async validateRequest(request: VideoGenerationRequest): Promise<string> {
    runwayDuration(request.durationSeconds);
    if (!request.prompt.trim() || request.prompt.length > 1000) throw new ProviderError("Runway: prompt deve ter de 1 a 1000 caracteres.");
    const uri = request.referenceImageUris[0];
    if (!uri) throw new ProviderError("Runway exige uma foto do produto.");
    const image = await new AssetResolver([this.uploadsDir]).resolve(uri);
    if (image.kind !== "file" || image.media !== "image") throw new ProviderError("Runway exige imagem local válida.");
    const bytes = await readFile(image.absolutePath);
    const data = `data:${image.contentType};base64,${bytes.toString("base64")}`;
    if (Buffer.byteLength(data) > 5 * 1024 * 1024) throw new ProviderError("Runway: imagem codificada passa de 5 MB; reduza a foto.");
    return data;
  }
  async generateScene(request: VideoGenerationRequest): Promise<ProviderJobRef> {
    const promptImage = await this.validateRequest(request);
    const seconds = runwayDuration(request.durationSeconds);
    const body = await this.api("/image_to_video", { method: "POST", body: JSON.stringify({
      model: RUNWAY_VIDEO.model, promptImage, promptText: request.prompt, duration: seconds, ratio: "720:1280",
    }) });
    const parsed = z.object({ id: z.string().min(1).max(256) }).safeParse(body);
    if (!parsed.success) throw new ProviderError("Runway: resposta de criação inválida; possível cobrança. Não houve nova tentativa.");
    this.jobs.set(parsed.data.id, { seconds });
    return { providerJobId: parsed.data.id };
  }
  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    const job = this.job(ref);
    const parsed = TaskSchema.safeParse(await this.api(`/tasks/${encodeURIComponent(ref.providerJobId)}`, {}, ref.providerJobId));
    if (!parsed.success || parsed.data.id !== ref.providerJobId) throw new ProviderError("Runway: status inválido; possível cobrança não confirmada.", ref.providerJobId);
    const task = parsed.data;
    // Algumas versões da API não retornam cost: sucesso = duração solicitada pela tarifa oficial.
    const usage = { seconds: task.cost ? task.cost.credits / RUNWAY_CREDITS_PER_SECOND : job.seconds };
    if (task.status === "SUCCEEDED") {
      job.usage = usage;
      job.output = task.output?.[0];
      return { ...ref, state: "succeeded", billedUsage: usage };
    }
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      const diagnostic: ProviderDiagnostic = { ...this.diagnostics.get(ref.providerJobId)!, kind: "provider", billing: task.cost ? "confirmed" : "unconfirmed" };
      return { ...ref, state: "failed", error: this.failure(diagnostic, ref.providerJobId).message,
        diagnostic, billedUsage: task.cost ? usage : undefined };
    }
    return { ...ref, state: task.status === "RUNNING" ? "running" : "queued" };
  }
  async downloadResult(ref: ProviderJobRef): Promise<MediaResult> {
    const job = this.job(ref);
    if (!job.usage) throw new ProviderError("Runway: resultado ainda indisponível", ref.providerJobId);
    try {
      const url = new URL(job.output ?? "");
      // Apenas CDN HTTPS do fornecedor; sem redirects, credenciais ou hosts arbitrários.
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["runwayml.com", "runway.com", "cloudfront.net"].some((host) => url.hostname.endsWith(`.${host}`))) {
        throw new Error("URL inválida");
      }
      const response = await this.transport(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!response.ok || Number(response.headers.get("content-length")) > 100 * 1024 * 1024) throw new Error("Download inválido");
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Error("Sem conteúdo");
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Arquivo muito grande"); }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (!isMp4(data)) throw new Error("Conteúdo não é MP4");
      return { uri: "", data, mimeType: "video/mp4", durationSeconds: job.seconds, billedUsage: job.usage, isMock: false };
    } catch {
      throw new ProviderError("Runway gerou o clipe, mas o download falhou. Custo preservado; não houve nova geração.", ref.providerJobId, job.usage);
    }
  }
  private job(ref: ProviderJobRef) {
    const job = this.jobs.get(ref.providerJobId);
    if (!job) throw new ProviderError("Runway: tarefa desconhecida", ref.providerJobId);
    return job;
  }
  /** Seleciona somente campos diagnósticos; nunca inclui body, payload ou erro bruto. */
  private clean(value: unknown, sensitive: string[] = []): string | undefined {
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
  private failure(diagnostic: ProviderDiagnostic, id?: string): ProviderError {
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
  private async api(path: string, init: RequestInit = {}, id?: string): Promise<unknown> {
    const creating = init.method === "POST";
    const sensitive: string[] = [];
    if (typeof init.body === "string") {
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      for (const value of Object.values(payload)) if (typeof value === "string" && (value === payload.promptText || value === payload.promptImage)) { sensitive.push(value); if (value.startsWith("data:")) sensitive.push(value.split(",")[1] ?? ""); }
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
      if (!creating && id) this.diagnostics.set(id, diagnostic);
      return body;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw this.failure({ ...diagnostic, kind: timeout ? "timeout" : "connection" }, id);
    }
  }
}
