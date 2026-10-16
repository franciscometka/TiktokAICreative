import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import { PRICING_TABLE } from "@/config/pricing";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { ugcPricingRefs, ugcVeoPreset } from "@/config/ugc-models";
import { googleUgcReadiness } from "@/config/ugc-readiness";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { product } from "@/test/fixtures";
import { FAKE_GOOGLE_KEY, googleFake, PNG_1X1, VEO_OPERATION } from "@/test/google-fake";
import { makeMp4 } from "@/test/mp4-fixture";
import { waitForCompletion } from "../poll";
import { buildGoogleUgcReferenceRequest, buildVeoUgcVideoRequest } from "./google-ugc-contract";
import { GoogleAiHttpClient, GoogleUgcError } from "./google-http";
import { GeminiReferenceTransport, VeoVideoTransport } from "./google-transports";
import { createUgcProviderFactories, type GoogleUgcRuntime } from "./index";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const item = product({ images: [{ id: "img_1", uri: "outputs/uploads/p/img_1.png" }] });
const anchor = productAnchor(item)!;
const identity = resolveUgcIdentity({ id: "character_1", revision: 1, product: item, request: { presenter: "woman", environment: "studio", visualStyle: "natural_smartphone" } });
const loadImage = async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" });
const referenceRequest = buildGoogleUgcReferenceRequest({ product: anchor, identity, prompt: "creator holding the exact product", aspectRatio: "9:16" });
const veoRequest = buildVeoUgcVideoRequest({
  sceneId: "scene_1", role: "ugc_hook", reference: { id: "ref_1", version: "v1", imageUri: "outputs/ugc/c/v1/reference.png", approved: true },
  identity, product: anchor, speech: "Olha isso aqui.", action: "holds the product", durationSeconds: 8, aspectRatio: "9:16", additionalReferenceUris: [anchor.imageUri],
}, ugcVeoPreset("high"));
const env = (extra: Record<string, string> = {}) => ({ GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY, UGC_PROVIDER: "google", UGC_REAL_ALLOWED: "true", ...extra });
const http = (fake: ReturnType<typeof googleFake>) => new GoogleAiHttpClient(FAKE_GOOGLE_KEY, fake.fetch);

describe("readiness Google AI UGC", () => {
  it("chave ausente bloqueia; chave sozinha NÃO habilita; tudo explícito habilita", () => {
    const base = loadAppConfig({});
    expect(googleUgcReadiness(base, {})).toMatchObject({ ready: false });
    expect(googleUgcReadiness(base, {}).reason).toMatch(/GOOGLE_AI_API_KEY não configurada/);
    expect(googleUgcReadiness(base, { GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY }).ready).toBe(false);
    expect(googleUgcReadiness(loadAppConfig({ UGC_PROVIDER: "google" }), { GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY }).reason).toMatch(/UGC_REAL_ALLOWED=false/);
    const ready = googleUgcReadiness(loadAppConfig(env()), env());
    expect(ready.ready).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(FAKE_GOOGLE_KEY);
  });

  it("factory REAL recusa sem readiness e nunca toca a rede", () => {
    const fake = googleFake();
    const runtime: GoogleUgcRuntime = { apiKey: FAKE_GOOGLE_KEY, readiness: googleUgcReadiness(loadAppConfig({}), {}), loadImage, transport: fake.fetch };
    const factories = createUgcProviderFactories({ google: runtime });
    expect(() => factories.reference(catalog.requireOne(ugcPricingRefs("high").reference), "real")).toThrow(/indisponível/);
    expect(() => factories.video(catalog.requireOne(ugcPricingRefs("high").video), "real")).toThrow(/indisponível/);
    expect(fake.calls).toHaveLength(0);
    const ready = createUgcProviderFactories({ google: { ...runtime, readiness: googleUgcReadiness(loadAppConfig(env()), env()) } });
    expect(ready.reference(catalog.requireOne(ugcPricingRefs("high").reference), "real").descriptor).toMatchObject({ id: "google", isMock: false });
    expect(ready.video(catalog.requireOne(ugcPricingRefs("high").video), "real").audioStrategy).toBe("native_speech");
  });
});

describe("Gemini image (referência)", () => {
  it("sucesso: UM POST com chave só no header, imagem inline e 9:16; resultado com request id e usage", async () => {
    const fake = googleFake();
    const transport = new GeminiReferenceTransport(http(fake), loadImage);
    const ref = await transport.submit(referenceRequest);
    expect(fake.posts()).toBe(1);
    const call = fake.calls[0]!;
    expect(call.url).toMatch(/models\/gemini-3\.1-flash-image:generateContent$/);
    expect(call.url).not.toContain(FAKE_GOOGLE_KEY);
    expect(call.headers["x-goog-api-key"]).toBe(FAKE_GOOGLE_KEY);
    expect(JSON.stringify(call.body)).toContain("inlineData");
    expect(call.body).toMatchObject({ generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "1K" } } });
    expect((await transport.poll(ref.providerJobId)).state).toBe("succeeded");
    const result = await transport.download(ref.providerJobId);
    expect(result).toMatchObject({ mimeType: "image/png", width: 1, height: 1, billedUsage: { generations: 1 }, requestId: "req_img", metadata: { promptTokens: 300, outputTokens: 1290 } });
  });

  it("A) 400 = rejeitado antes da operação; erro tipado e sanitizado", async () => {
    const fake = googleFake({ image: "rejected" });
    const error = await new GeminiReferenceTransport(http(fake), loadImage).submit(referenceRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
    expect(error).toBeInstanceOf(GoogleUgcError);
    expect(error.phase).toBe("rejected_before_operation");
    expect(error.diagnostic).toMatchObject({ httpStatus: 400, requestId: "req_img", providerCode: "INVALID_ARGUMENT", billing: "rejected", operation: "none" });
    expect(`${error.message}${JSON.stringify(error.diagnostic)}`).not.toContain(FAKE_GOOGLE_KEY);
  });

  it("C) 5xx/rede após envio = incerto; B) 200 sem imagem = falhou depois", async () => {
    for (const image of ["server_error", "network"] as const) {
      const error = await new GeminiReferenceTransport(http(googleFake({ image })), loadImage).submit(referenceRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
      expect(error.phase).toBe("uncertain");
      expect(error.diagnostic?.operation).toBe("unknown");
      expect(error.message).not.toContain(FAKE_GOOGLE_KEY);
    }
    const blocked = await new GeminiReferenceTransport(http(googleFake({ image: "no_image" })), loadImage).submit(referenceRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
    expect(blocked.phase).toBe("failed_after_operation");
    expect(blocked.diagnostic?.providerCode).toBe("IMAGE_SAFETY");
    const invalid = await new GeminiReferenceTransport(http(googleFake({ image: "invalid_image" })), loadImage).submit(referenceRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
    expect(invalid.billedUsage).toEqual({ generations: 1 });
  });

  it("reinício após resposta sem persistência vira falha COBRADA, nunca novo envio", async () => {
    const fake = googleFake();
    const ref = await new GeminiReferenceTransport(http(fake), loadImage).submit(referenceRequest);
    const restarted = new GeminiReferenceTransport(http(fake), loadImage);
    const error = await restarted.poll(ref.providerJobId).catch(e => e as GoogleUgcError) as GoogleUgcError;
    expect(error.billedUsage).toEqual({ generations: 1 });
    expect(fake.posts()).toBe(1);
  });
});

describe("Veo 3.1 (cena)", () => {
  it("submit → operation ID → polling → download MP4 com áudio nativo", async () => {
    const fake = googleFake({ veoRunningPolls: 1 });
    const transport = new VeoVideoTransport(http(fake), loadImage);
    const ref = await transport.submit(veoRequest);
    expect(ref.providerJobId).toBe(VEO_OPERATION);
    const body = fake.calls[0]!.body as { instances: { referenceImages?: unknown[] }[]; parameters: Record<string, unknown> };
    expect(body.parameters).toMatchObject({ aspectRatio: "9:16", resolution: "720p", durationSeconds: 8, personGeneration: "allow_adult" });
    expect(body.instances[0]!.referenceImages).toHaveLength(1);
    await waitForCompletion(r => transport.poll(r.providerJobId), ref, { maxPolls: 3, intervalMs: 0, sleep: async () => {} });
    const result = await transport.download(ref.providerJobId);
    expect(result).toMatchObject({ mimeType: "video/mp4", hasAudio: true, requestedDurationSeconds: 8, billedUsage: { seconds: 8 }, durationSeconds: 8 });
    expect(fake.posts()).toBe(1);
  });

  it("retomada após reinício: só GET pelo operation ID, nenhum novo POST", async () => {
    const fake = googleFake();
    const restarted = new VeoVideoTransport(http(fake), loadImage);
    expect((await restarted.poll(VEO_OPERATION)).state).toBe("succeeded");
    const result = await restarted.download(VEO_OPERATION);
    expect(result.hasAudio).toBe(true);
    expect(result.billedUsage).toEqual({}); // duração vem da intenção persistida no pipeline
    expect(fake.posts()).toBe(0);
  });

  it("B) operação criada que falha/filtra devolve failed com operation=created", async () => {
    for (const veoOutcome of ["error", "filtered"] as const) {
      const status = await new VeoVideoTransport(http(googleFake({ veoOutcome })), loadImage).poll(VEO_OPERATION);
      expect(status.state).toBe("failed");
      expect(status.diagnostic).toMatchObject({ operation: "created", billing: "unconfirmed" });
    }
  });

  it("C) rede no submit e 200 sem operation name = incerto; A) 403 = rejeitado", async () => {
    for (const veoSubmit of ["network", "no_name"] as const) {
      const error = await new VeoVideoTransport(http(googleFake({ veoSubmit })), loadImage).submit(veoRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
      expect(error.phase).toBe("uncertain");
    }
    const rejected = await new VeoVideoTransport(http(googleFake({ veoSubmit: "rejected" })), loadImage).submit(veoRequest).catch(e => e as GoogleUgcError) as GoogleUgcError;
    expect(rejected.phase).toBe("rejected_before_operation");
  });

  it("download: redirect segue SEM a chave; host fora da allowlist é recusado; MP4 sem áudio é sinalizado", async () => {
    const fake = googleFake({ redirect: "https://video-cdn.googleusercontent.com/clip.mp4" });
    const transport = new VeoVideoTransport(http(fake), loadImage);
    await transport.poll(VEO_OPERATION);
    await transport.download(VEO_OPERATION);
    const cdn = fake.calls.find(call => call.url.includes("googleusercontent"))!;
    expect(cdn.headers["x-goog-api-key"]).toBeUndefined();
    await expect(new GoogleAiHttpClient(FAKE_GOOGLE_KEY, fake.fetch).download("https://evil.example.com/x.mp4", VEO_OPERATION)).rejects.toThrow(/resposta inválida/);
    const silent = new VeoVideoTransport(http(googleFake({ clip: makeMp4(8) })), loadImage);
    await silent.poll(VEO_OPERATION);
    expect((await silent.download(VEO_OPERATION)).hasAudio).toBe(false);
  });
});
