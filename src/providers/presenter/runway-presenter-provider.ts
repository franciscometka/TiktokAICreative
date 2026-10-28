import { AvatarPresetSchema } from "@/domain/presenter";
import { presenterWavDuration } from "./wav";
import { RUNWAY_PRESENTER, presenterBilledSeconds } from "@/config/presenters";
import { RUNWAY_CREDIT_USD } from "@/config/pricing";
import { costForUsage } from "@/costs/calculate";
import type { ProviderPricing } from "@/domain/cost";
import { ProviderError } from "../types";
import { RunwayHttpClient, TaskSchema } from "../runway-http";
import { isMp4 } from "../video/mp4";
import type { PresenterProvider, PresenterRef, PresenterRequest } from "./presenter-provider";
export class RunwayPresenterProvider implements PresenterProvider {
  readonly descriptor;
  private client?: RunwayHttpClient;
  readonly #apiKey: string;
  private readonly injectedTransport: typeof fetch | undefined;
  private readonly transport: typeof fetch;
  constructor(options: { pricing: ProviderPricing; apiKey: string; transport?: typeof fetch }) {
    if (options.pricing.model !== RUNWAY_PRESENTER.model || options.pricing.provider !== "runway") throw new ProviderError("Preço/modelo de presenter incompatível; aprove nova estimativa.");
    this.transport = options.transport ?? fetch;
    this.injectedTransport = options.transport;
    this.#apiKey = options.apiKey;
    this.descriptor = { ...RUNWAY_PRESENTER, id: "runway", isMock: false, pricing: options.pricing };
  }
  /** Cliente HTTP só quando há requisição: estimar custo (abrir o projeto) não exige a chave; sem chave, nada é enviado. */
  private get http(): RunwayHttpClient {
    return this.client ??= new RunwayHttpClient(this.#apiKey, this.injectedTransport);
  }
  estimateCost(seconds: number) {
    return { kind: "estimate" as const, ...costForUsage(this.descriptor.pricing, { seconds: presenterBilledSeconds(seconds) }), pricing: this.descriptor.pricing };
  }
  async submit(request: PresenterRequest): Promise<PresenterRef> {
    AvatarPresetSchema.parse(request.avatarPresetId);
    presenterBilledSeconds(request.durationSeconds);
    try {
      if (Math.abs(presenterWavDuration(request.audio) - request.durationSeconds) > 0.02) throw new Error("duração divergente");
    } catch { throw new ProviderError("Presenter exige WAV PCM íntegro com a duração do trecho solicitado.", undefined, undefined, { kind: "invalid_request", billing: "rejected" }); }
    const audio = `data:audio/wav;base64,${Buffer.from(request.audio).toString("base64")}`;
    if (Buffer.byteLength(audio) > 5 * 1024 * 1024) throw new ProviderError("Presenter: áudio codificado excede 5 MB.");
    const body = await this.http.api("/avatar_videos", { method: "POST", body: JSON.stringify({ model: RUNWAY_PRESENTER.model,
      avatar: { type: "runway-preset", presetId: request.avatarPresetId }, speech: { type: "audio", audio } }) }) as { id: string };
    return { providerJobId: body.id, requestId: this.http.lastDiagnostic?.requestId, requestedDurationSeconds: request.durationSeconds };
  }
  private async task(ref: PresenterRef) {
    return TaskSchema.parse(await this.http.api(`/tasks/${encodeURIComponent(ref.providerJobId)}`, {}, ref.providerJobId));
  }
  private usage(credits: number | undefined, seconds: number) {
    return { seconds: credits === undefined ? presenterBilledSeconds(seconds) : credits * RUNWAY_CREDIT_USD / this.descriptor.pricing.priceUsd };
  }
  async getStatus(ref: PresenterRef) {
    const task = await this.task(ref);
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      const diagnostic = { ...this.http.lastDiagnostic!, kind: "provider" as const, billing: task.cost ? "confirmed" as const : "unconfirmed" as const };
      return { providerJobId: ref.providerJobId, state: "failed" as const, error: this.http.failure(diagnostic, ref.providerJobId).message, diagnostic,
        billedUsage: task.cost ? this.usage(task.cost.credits, ref.requestedDurationSeconds) : undefined };
    }
    return { providerJobId: ref.providerJobId, state: task.status === "SUCCEEDED" ? "succeeded" as const : task.status === "RUNNING" ? "running" as const : "queued" as const };
  }
  async downloadResult(ref: PresenterRef) {
    const task = await this.task(ref);
    if (task.status !== "SUCCEEDED") throw new ProviderError("Presenter ainda não está pronto", ref.providerJobId);
    const usage = this.usage(task.cost?.credits, ref.requestedDurationSeconds);
    try {
      const url = new URL(task.output?.[0] ?? "");
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
      return { providerReportedDurationSeconds: task.duration, uri: "", data, mimeType: "video/mp4", durationSeconds: ref.requestedDurationSeconds, requestedDurationSeconds: ref.requestedDurationSeconds, billedUsage: usage, isMock: false };
    } catch {
      throw new ProviderError("Runway gerou o clipe, mas o download falhou. Custo preservado; não houve nova geração.", ref.providerJobId, usage);
    }
  }
}
