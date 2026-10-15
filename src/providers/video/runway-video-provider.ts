import { RunwayHttpClient } from "../runway-http";
import { pickOutputRatio } from "@/domain/aspect";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
import { isMp4 } from "./mp4";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RUNWAY_VIDEO, RUNWAY_RATIOS, runwayDuration } from "@/config/video-models";
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
  private readonly http: RunwayHttpClient;
  private readonly transport: typeof fetch;
  private readonly jobs = new Map<string, { seconds: number; output?: string; usage?: Usage }>();
  private readonly pricing: ProviderPricing;
  private readonly uploadsDir: string;
  constructor(options: RunwayOptions) {
    this.pricing = options.pricing;
    this.uploadsDir = options.uploadsDir;
    if (!options.apiKey) throw new ProviderError("RUNWAYML_API_SECRET não configurada");
    if (options.pricing.provider !== RUNWAY_VIDEO.provider || options.pricing.model !== RUNWAY_VIDEO.model) {
      throw new ProviderError("O plano usa outro modelo de vídeo. Crie uma nova campanha com Runway e aprove a nova estimativa.");
    }
    this.transport = options.transport ?? fetch;
    this.http = new RunwayHttpClient(options.apiKey, options.transport);
    this.descriptor = { id: RUNWAY_VIDEO.provider, model: RUNWAY_VIDEO.model, isMock: false, pricing: options.pricing };
  }
  estimateCost(request: VideoGenerationRequest) {
    const cost = costForUsage(this.pricing, { seconds: runwayDuration(request.durationSeconds) });
    return { kind: "estimate" as const, ...cost, pricing: this.pricing };
  }
  async validateRequest(request: VideoGenerationRequest): Promise<string> {
    if (request.visualSource === "presenter" || request.visualSource === "product_ugc") throw new ProviderError("Tipo de cena ainda não suportado nesta integração Runway; revise o plano.");
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
  async outputRatio(request: VideoGenerationRequest): Promise<string> {
    const uri = request.referenceImageUris[0];
    if (!uri) throw new ProviderError("Runway exige uma foto do produto.");
    const image = await new AssetResolver([this.uploadsDir]).resolve(uri);
    if (image.kind !== "file" || image.media !== "image") throw new ProviderError("Runway exige imagem local válida.");
    return pickOutputRatio(RUNWAY_RATIOS, image.size.width / image.size.height, "full_product").ratio;
  }
  async generateScene(request: VideoGenerationRequest): Promise<ProviderJobRef> {
    const promptImage = await this.validateRequest(request);
    const seconds = runwayDuration(request.durationSeconds);
    const body = await this.api("/image_to_video", { method: "POST", body: JSON.stringify({
      model: RUNWAY_VIDEO.model, promptImage, promptText: request.prompt, duration: seconds, ratio: await this.outputRatio(request),
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
      const diagnostic: ProviderDiagnostic = { ...this.http.diagnostics.get(ref.providerJobId)!, kind: "provider", billing: task.cost ? "confirmed" : "unconfirmed" };
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
      // A tarefa da Runway não informa a duração do vídeo: só a pedida é conhecida aqui. A duração
      // REAL é medida pelo pipeline no arquivo salvo.
      return { uri: "", data, mimeType: "video/mp4", durationSeconds: job.seconds, requestedDurationSeconds: job.seconds, billedUsage: job.usage, isMock: false };
    } catch {
      throw new ProviderError("Runway gerou o clipe, mas o download falhou. Custo preservado; não houve nova geração.", ref.providerJobId, job.usage);
    }
  }
  resumeTask(ref: ProviderJobRef, request: VideoGenerationRequest): void {
    this.jobs.set(ref.providerJobId, { seconds: runwayDuration(request.durationSeconds) });
  }
  private job(ref: ProviderJobRef) {
    const job = this.jobs.get(ref.providerJobId);
    if (!job) throw new ProviderError("Runway: tarefa desconhecida", ref.providerJobId);
    return job;
  }
  private api(path: string, init: RequestInit = {}, id?: string) { return this.http.api(path, init, id); }
  private failure(diagnostic: ProviderDiagnostic, id?: string) { return this.http.failure(diagnostic, id); }
}
