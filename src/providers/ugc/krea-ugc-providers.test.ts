import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import { kreaRequestedDuration, kreaUgcPricingRefs, kreaVeoConfigForPricingModel } from "@/config/krea-ugc-models";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { PRICING_TABLE } from "@/config/pricing";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { ugcPricingRefs } from "@/config/ugc-models";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { product } from "@/test/fixtures";
import { PNG_1X1 } from "@/test/google-fake";
import { FAKE_KREA_KEY, KREA_ASSET_ID, KREA_IMAGE_JOB, KREA_VIDEO_JOB, kreaFake, type KreaFakeOptions } from "@/test/krea-fake";
import { makeMp4 } from "@/test/mp4-fixture";
import { waitForCompletion } from "../poll";
import { KreaHttpClient, KreaUgcError } from "./krea-http";
import { buildKreaReferenceBody, buildKreaVeoBody, parseKreaJobRef, UgcReferenceProviderKrea, UgcVideoProviderKrea } from "./krea-ugc-providers";
import { createUgcProviderFactories, type KreaUgcRuntime } from "./index";
import type { UgcVideoRequest } from "./ugc-providers";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const item = product({ images: [{ id: "img_1", uri: "outputs/uploads/p/img_1.png" }] });
const anchor = productAnchor(item)!;
const identity = resolveUgcIdentity({ id: "character_1", revision: 1, product: item, request: { presenter: "woman", environment: "studio", visualStyle: "natural_smartphone" } });
const loadImage = async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" });
const referenceRequest = { product: anchor, identity, prompt: "creator holding the exact product", aspectRatio: "9:16" as const };
const videoRequest: UgcVideoRequest = {
  sceneId: "scene_1", role: "ugc_hook", reference: { id: "ref_1", version: "v1", imageUri: "outputs/ugc/c/v1/reference.png", approved: true },
  identity, product: anchor, speech: "Olha isso aqui.", action: "holds the product", durationSeconds: 7, aspectRatio: "9:16",
};
const env = (extra: Record<string, string> = {}) => ({ KREA_API_KEY: FAKE_KREA_KEY, UGC_PROVIDER: "krea", UGC_REAL_ALLOWED: "true", ...extra });
const refs = kreaUgcPricingRefs("high");
const http = (fake: ReturnType<typeof kreaFake>) => new KreaHttpClient(FAKE_KREA_KEY, fake.fetch);
const reference = (options: KreaFakeOptions = {}) => { const fake = kreaFake(options); return { fake, provider: new UgcReferenceProviderKrea(catalog.requireOne(refs.reference), http(fake), loadImage) }; };
const submitReference = async (provider: UgcReferenceProviderKrea) => provider.submit(referenceRequest, await provider.prepare(referenceRequest));
const video = (options: KreaFakeOptions = {}, quality: "high" | "premium" = "high") => { const fake = kreaFake(options); return { fake, provider: new UgcVideoProviderKrea(catalog.requireOne(kreaUgcPricingRefs(quality).video), http(fake), loadImage) }; };
const submitVideo = async (provider: UgcVideoProviderKrea, request = videoRequest) => provider.submit(request, await provider.prepare(request));
const poll = { maxPolls: 5, intervalMs: 0, sleep: async () => {} };

describe("modelos e preços Krea", () => {
  it("presets usam Veo 3.1 Fast com áudio (Premium 1080p) e Nano Banana 2; preços oficiais por requisição", () => {
    expect(kreaUgcPricingRefs("economy")).toEqual({ reference: { provider: "krea", model: "nano-banana-2" }, video: { provider: "krea", model: "veo-3.1-fast" } });
    expect(kreaUgcPricingRefs("premium").video.model).toBe("veo-3.1-fast:1080p");
    expect(kreaVeoConfigForPricingModel("veo-3.1-fast:1080p")).toMatchObject({ endpoint: "/generate/video/google/veo-3.1-fast", resolution: "1080p", nativeAudio: true });
    expect(() => kreaVeoConfigForPricingModel("veo-3.1-lite")).toThrow(/não reconhecido/);
    expect([1, 4, 4.1, 5.5, 6, 7, 8, 12].map(kreaRequestedDuration)).toEqual([4, 4, 6, 6, 6, 8, 8, 8]);
    expect(catalog.requireOne(refs.reference)).toMatchObject({ unit: "per_generation", priceUsd: 0.08, isPlaceholder: false });
    // 8s Fast 720p = US$0,80; 1080p = US$0,96 (tabela oficial da Krea).
    expect(video().provider.estimateCost(8).costUsd).toBeCloseTo(0.8, 6);
    expect(video({}, "premium").provider.estimateCost(8).costUsd).toBeCloseTo(0.96, 6);
    expect(video().provider.estimateCost(5).costUsd).toBeCloseTo(0.6, 6);
    expect(reference().provider.estimateCost().costUsd).toBeCloseTo(0.08, 6);
  });

  it("refs Google continuam intactas", () => {
    expect(ugcPricingRefs("high").reference.provider).toBe("google");
    expect(catalog.requireOne(ugcPricingRefs("high").video).provider).toBe("google");
  });
});

describe("readiness e factory Krea", () => {
  it("chave sozinha não habilita; segredo nunca aparece", () => {
    expect(kreaUgcReadiness(loadAppConfig({}), {}).reason).toMatch(/KREA_API_KEY não configurada/);
    expect(kreaUgcReadiness(loadAppConfig({}), { KREA_API_KEY: FAKE_KREA_KEY }).ready).toBe(false);
    expect(kreaUgcReadiness(loadAppConfig({ UGC_PROVIDER: "krea" }), { KREA_API_KEY: FAKE_KREA_KEY }).reason).toMatch(/UGC_REAL_ALLOWED=false/);
    const ready = kreaUgcReadiness(loadAppConfig(env()), env());
    expect(ready.ready).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(FAKE_KREA_KEY);
    expect(JSON.stringify(loadAppConfig(env()))).not.toContain(FAKE_KREA_KEY);
  });

  it("factory: mock por padrão; REAL Krea só com readiness; preço Google continua no ramo Google", () => {
    const fake = kreaFake();
    const runtime: KreaUgcRuntime = { apiKey: FAKE_KREA_KEY, readiness: kreaUgcReadiness(loadAppConfig({}), {}), loadImage, transport: fake.fetch };
    const blocked = createUgcProviderFactories({ krea: runtime });
    expect(blocked.reference(catalog.requireOne(refs.reference), "mock").descriptor.isMock).toBe(true);
    expect(() => blocked.reference(catalog.requireOne(refs.reference), "real")).toThrow(/Krea\) indisponível/);
    expect(() => blocked.video(catalog.requireOne(refs.video), "real")).toThrow(/Krea\) indisponível/);
    const factories = createUgcProviderFactories({ krea: { ...runtime, readiness: kreaUgcReadiness(loadAppConfig(env()), env()) } });
    expect(factories.reference(catalog.requireOne(refs.reference), "real")).toBeInstanceOf(UgcReferenceProviderKrea);
    const v = factories.video(catalog.requireOne(refs.video), "real");
    expect(v).toBeInstanceOf(UgcVideoProviderKrea);
    expect(v.audioStrategy).toBe("native_speech");
    // Preço Google com runtime Krea pronto: ramo Google (sem runtime Google → recusa), nunca Krea.
    expect(() => factories.reference(catalog.requireOne(ugcPricingRefs("high").reference), "real")).toThrow(/Google/);
    expect(fake.calls).toHaveLength(0);
  });

  it("cliente sem chave recusa antes de qualquer rede", () => {
    expect(() => new KreaHttpClient("")).toThrow(/KREA_API_KEY/);
  });
});

describe("builders puros", () => {
  it("referência: foto do produto por URL de asset, 9:16, 1K", () => {
    const body = buildKreaReferenceBody(referenceRequest, "https://gen.krea.ai/assets/a.png");
    expect(body).toMatchObject({ image_urls: ["https://gen.krea.ai/assets/a.png"], aspect_ratio: "9:16", resolution: "1K" });
    expect(body.prompt).toContain("Preserve exactly");
  });

  it("vídeo: start_image = referência aprovada, áudio nativo, duração 4/6/8; recusa áudio externo e extras", () => {
    const config = kreaVeoConfigForPricingModel("veo-3.1-fast");
    expect(buildKreaVeoBody(videoRequest, config, "https://x/ref.png")).toEqual(expect.objectContaining({ start_image: "https://x/ref.png", duration: 8, generate_audio: true, aspect_ratio: "9:16", resolution: "720p" }));
    expect(buildKreaVeoBody(videoRequest, config, "u").prompt).toContain("Olha isso aqui.");
    expect(() => buildKreaVeoBody({ ...videoRequest, audio: { data: new Uint8Array(1), startSeconds: 0, endSeconds: 1, narrationVersion: "v1" } }, config, "u")).toThrow(/áudio nativo/);
    expect(() => buildKreaVeoBody({ ...videoRequest, additionalReferenceUris: ["x.png"] }, config, "u")).toThrow(/referência aprovada/);
  });

  it("job ref carrega a duração comprada e rejeita IDs estranhos", () => {
    expect(parseKreaJobRef(`krea:${KREA_VIDEO_JOB}:8s`)).toEqual({ jobId: KREA_VIDEO_JOB, seconds: 8 });
    expect(parseKreaJobRef(`krea:${KREA_IMAGE_JOB}`)).toEqual({ jobId: KREA_IMAGE_JOB });
    expect(() => parseKreaJobRef("krea:../etc")).toThrow(/inválido/);
  });
});

describe("referência Nano Banana 2 via Krea (fetch falso)", () => {
  it("upload do asset → UM POST pago → polling → PNG; chave só no header", async () => {
    const { fake, provider } = reference({ runningPolls: 1 });
    const ref = await submitReference(provider);
    expect(ref.providerJobId).toBe(`krea:${KREA_IMAGE_JOB}`);
    expect(ref.requestId).toBe("req_krea");
    expect(fake.calls[0]).toMatchObject({ method: "POST", url: "https://api.krea.ai/assets", multipart: true });
    const post = fake.calls.find(c => c.url.endsWith("/generate/image/google/nano-banana-2"))!;
    expect(post.body).toMatchObject({ image_urls: ["https://gen.krea.ai/assets/asset_1.png"], aspect_ratio: "9:16", resolution: "1K" });
    expect(fake.posts()).toBe(1);
    expect((await provider.getStatus(ref)).state).toBe("running");
    expect(await waitForCompletion(r => provider.getStatus(r), ref, poll)).toMatchObject({ state: "succeeded" });
    const result = await provider.downloadResult(ref);
    expect(result).toMatchObject({ mimeType: "image/png", width: 1, height: 1, billedUsage: { generations: 1 }, isMock: false });
    const download = fake.calls.find(c => c.url.startsWith("https://gen.krea.ai/images/"))!;
    expect(download.headers.authorization).toBeUndefined();
    for (const call of fake.calls.filter(c => c.url.startsWith("https://api.krea.ai"))) expect(call.headers.authorization).toBe(`Bearer ${FAKE_KREA_KEY}`);
    expect(fake.calls.every(c => !c.url.includes(FAKE_KREA_KEY))).toBe(true);
  });

  it("aceita result.urls como lista de objetos", async () => {
    const { provider } = reference({ urlShape: "objects" });
    const ref = await submitReference(provider);
    expect((await provider.downloadResult(ref)).mimeType).toBe("image/png");
  });

  it("400 na criação: rejected_before_job, sem segredo, sem novo envio", async () => {
    const { fake, provider } = reference({ create: "rejected" });
    const error = await submitReference(provider).then(() => { throw new Error("esperava erro"); }, e => e as KreaUgcError);
    expect(error).toBeInstanceOf(KreaUgcError);
    expect(error).toMatchObject({ phase: "rejected_before_job", diagnostic: { billing: "rejected", operation: "none", httpStatus: 400, requestId: "req_krea" } });
    expect(error.message).not.toContain(FAKE_KREA_KEY);
    expect(JSON.stringify(error.diagnostic)).not.toContain(FAKE_KREA_KEY);
    expect(fake.posts()).toBe(1);
  });

  it("rede após envio ou 200 sem job_id: uncertain (pode ter cobrado), nunca reenvia", async () => {
    for (const create of ["network", "no_job_id"] as const) {
      const { fake, provider } = reference({ create });
      const error = await submitReference(provider).then(() => { throw new Error("esperava erro"); }, e => e as KreaUgcError);
      expect(error).toMatchObject({ phase: "uncertain" });
      expect(error.message).not.toContain(FAKE_KREA_KEY);
      expect(fake.posts()).toBe(1);
    }
  });

  it("job failed: status failed com mensagem sanitizada", async () => {
    const { provider } = reference({ outcome: "failed" });
    const ref = await submitReference(provider);
    const status = await provider.getStatus(ref);
    expect(status).toMatchObject({ state: "failed", diagnostic: { providerCode: "nsfw", operation: "created", billing: "rejected" } });
    expect(status.error).not.toContain(FAKE_KREA_KEY);
  });

  it("completed sem urls: falha; imagem inválida: falha cobrada sem retry", async () => {
    const empty = reference({ outcome: "no_urls" });
    const emptyRef = await submitReference(empty.provider);
    expect((await empty.provider.getStatus(emptyRef)).state).toBe("succeeded");
    await expect(empty.provider.downloadResult(emptyRef)).rejects.toMatchObject({ billedUsage: { generations: 1 } });
    const bad = reference({ image: new TextEncoder().encode("not-an-image") });
    const error = await bad.provider.downloadResult(await submitReference(bad.provider)).catch(e => e as KreaUgcError);
    expect(error).toMatchObject({ phase: "failed_after_job", billedUsage: { generations: 1 } });
  });

  it("download recusa HTTP e hosts privados sem rede; HTTPS público nunca recebe a chave", async () => {
    for (const resultUrl of ["http://gen.krea.ai/x.png", "https://localhost/x.png", "https://127.0.0.1/x.png", "https://[::1]/x.png"]) {
      const { fake, provider } = reference({ resultUrl });
      const ref = await submitReference(provider);
      await expect(provider.downloadResult(ref)).rejects.toBeInstanceOf(KreaUgcError);
      expect(fake.calls.some(c => c.url === resultUrl)).toBe(false);
    }
    const external = reference({ resultUrl: "https://cdn.example.com/x.png" });
    const ref = await submitReference(external.provider);
    await expect(external.provider.downloadResult(ref)).rejects.toBeInstanceOf(KreaUgcError);
    expect(external.fake.calls.find(c => c.url === "https://cdn.example.com/x.png")?.headers.authorization).toBeUndefined();
  });

  it("download segue redirect HTTPS público revalidado sem enviar Authorization", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}) });
      if (url === "https://cdn.example.com/start") return new Response(null, { status: 302, headers: { location: "https://media.example.net/result.png" } });
      if (url === "https://media.example.net/result.png") return new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png" } });
      return new Response(null, { status: 404 });
    };
    const client = new KreaHttpClient(FAKE_KREA_KEY, transport);
    await expect(client.download("https://cdn.example.com/start", KREA_IMAGE_JOB, "image")).resolves.toEqual(new Uint8Array(PNG_1X1));
    expect(calls).toEqual([
      { url: "https://cdn.example.com/start" },
      { url: "https://media.example.net/result.png" },
    ]);
  });

  it("preparação persiste hash/id/url e reutiliza asset confirmado sem novo upload", async () => {
    const { fake, provider } = reference();
    const first = await provider.prepare(referenceRequest);
    expect(first.metadata).toMatchObject({ kreaAssetProvider: "krea", kreaAssetVersion: 1, kreaAssetId: KREA_ASSET_ID });
    expect(first.metadata.kreaAssetHash).toMatch(/^[0-9a-f]{64}$/);
    const second = await provider.prepare(referenceRequest, first.metadata);
    expect(second).toEqual(first);
    expect(fake.calls.filter(c => c.method === "POST" && c.url.endsWith("/assets"))).toHaveLength(1);
    expect(fake.calls.filter(c => c.method === "GET" && c.url.includes("/assets/"))).toHaveLength(1);
  });
});

describe("cena Veo 3.1 via Krea (fetch falso)", () => {
  it("upload da referência aprovada → UM POST com áudio nativo → MP4 com trilha de áudio; custo pela duração comprada", async () => {
    const { fake, provider } = video({ runningPolls: 2 });
    const ref = await submitVideo(provider);
    expect(ref.providerJobId).toBe(`krea:${KREA_VIDEO_JOB}:8s`);
    const post = fake.calls.find(c => c.url.endsWith("/generate/video/google/veo-3.1-fast"))!;
    expect(post.body).toEqual({ prompt: expect.stringContaining("Brazilian Portuguese"), start_image: "https://gen.krea.ai/assets/asset_1.png", aspect_ratio: "9:16", duration: 8, generate_audio: true, resolution: "720p" });
    expect(await waitForCompletion(r => provider.getStatus(r), ref, poll)).toMatchObject({ state: "succeeded" });
    // Novo provider (reinício): o ID persistido basta para baixar e cobrar certo.
    const restarted = new UgcVideoProviderKrea(catalog.requireOne(refs.video), http(fake), loadImage);
    const result = await restarted.downloadResult(ref);
    expect(result).toMatchObject({ mimeType: "video/mp4", durationSeconds: 8, requestedDurationSeconds: 8, billedUsage: { seconds: 8 }, hasAudio: true, isMock: false });
    expect(fake.posts("video")).toBe(1);
  });

  it("pedido inválido é recusado antes de upload e POST", async () => {
    const { fake, provider } = video();
    await expect(submitVideo(provider, { ...videoRequest, aspectRatio: "16:9" as "9:16" })).rejects.toThrow(/9:16/);
    expect(fake.calls).toHaveLength(0);
  });

  it("clipe sem trilha de áudio é reportado (hasAudio=false) para o pipeline decidir", async () => {
    const { provider } = video({ clip: makeMp4(8) });
    const result = await provider.downloadResult(await submitVideo(provider));
    expect(result.hasAudio).toBe(false);
  });
});
