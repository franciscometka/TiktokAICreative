import { describe, expect, it } from "vitest";
import { PRICING_TABLE } from "@/config/pricing";
import { GEMINI_UGC_REFERENCE_MODEL, ugcPricingRefs, ugcVeoPreset, veoRequestedDuration, VEO_3_1_MODELS } from "@/config/ugc-models";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { product } from "@/test/fixtures";
import { buildGoogleUgcReferenceRequest, buildVeoUgcVideoRequest } from "./google-ugc-contract";
import { UgcReferenceProviderGoogle, UgcVideoProviderVeo, type GoogleUgcReferenceTransport, type VeoUgcVideoTransport } from "./google-ugc-providers";
import { createUgcProviderFactories } from "./index";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const item = product({ images: [{ id: "img_1", uri: "outputs/uploads/p/img_1.png" }] });
const anchor = productAnchor(item)!;
const identity = resolveUgcIdentity({ id: "character_1", revision: 1, product: item, request: { presenter: "woman", environment: "studio", visualStyle: "natural_smartphone" } });
const referenceRequest = { product: anchor, identity, prompt: "synthetic creator holding the exact product", aspectRatio: "9:16" as const };
const videoRequest = {
  sceneId: "scene_1", role: "ugc_hook" as const,
  reference: { id: "ref_1", version: "v1", imageUri: "outputs/ugc/c/v1/reference.png", approved: true as const },
  identity, product: anchor, speech: "Olha isso aqui.", action: "holds the product close to camera",
  durationSeconds: 5, aspectRatio: "9:16" as const, additionalReferenceUris: [anchor.imageUri], seed: 42,
};

describe("configuração Google AI UGC", () => {
  it("mapeia presets e preços oficiais sem números mágicos no pipeline", () => {
    expect(ugcVeoPreset("economy")).toMatchObject({ model: VEO_3_1_MODELS.lite, resolution: "720p" });
    expect(ugcVeoPreset("high")).toMatchObject({ model: VEO_3_1_MODELS.fast, resolution: "720p" });
    expect(ugcVeoPreset("premium")).toMatchObject({ model: VEO_3_1_MODELS.fast, resolution: "1080p" });
    expect(ugcVeoPreset("premium", "standard")).toMatchObject({ model: VEO_3_1_MODELS.standard, resolution: "1080p" });
    expect(catalog.requireOne(ugcPricingRefs("economy").video).priceUsd).toBe(0.05);
    expect(catalog.requireOne({ provider: "google", model: `${VEO_3_1_MODELS.lite}:1080p` }).priceUsd).toBe(0.08);
    expect(catalog.requireOne(ugcPricingRefs("high").video).priceUsd).toBe(0.10);
    expect(catalog.requireOne(ugcPricingRefs("premium").video).priceUsd).toBe(0.12);
    expect(catalog.requireOne(ugcPricingRefs("premium", "standard").video).priceUsd).toBe(0.40);
    expect(catalog.requireOne({ provider: "google", model: GEMINI_UGC_REFERENCE_MODEL })).toMatchObject({ priceUsd: 0.067, isPlaceholder: false });
  });

  it("normaliza duração 4/6/8 e força 8s para referência adicional ou 1080p", () => {
    expect(veoRequestedDuration(3.5, ugcVeoPreset("economy"))).toBe(4);
    expect(veoRequestedDuration(5, ugcVeoPreset("economy"))).toBe(6);
    expect(veoRequestedDuration(5, ugcVeoPreset("high"), 1)).toBe(8);
    expect(veoRequestedDuration(4, ugcVeoPreset("premium"))).toBe(8);
  });
});

describe("request builders Google", () => {
  it("usa text+image→image e preserva o produto original", () => {
    const request = buildGoogleUgcReferenceRequest(referenceRequest);
    expect(request).toMatchObject({ model: GEMINI_UGC_REFERENCE_MODEL, responseFormat: { aspectRatio: "9:16", imageSize: "1K" } });
    expect(request.input[1]).toEqual({ type: "image", sourceUri: anchor.imageUri, purpose: "preserve_product" });
    for (const term of ["shape", "colors", "logo", "packaging", "proportions"]) expect(request.input[0].text).toContain(term);
  });

  it("envia referência aprovada + produto, áudio nativo e seed sem prometer determinismo", () => {
    const request = buildVeoUgcVideoRequest(videoRequest, ugcVeoPreset("high"));
    expect(request.image).toMatchObject({ approvedReferenceId: "ref_1", approvedReferenceVersion: "v1" });
    expect(request.config).toMatchObject({ aspectRatio: "9:16", durationSeconds: "8", generateAudio: true, seed: 42 });
    expect(request.config.referenceImages?.[0]?.image.sourceUri).toBe(anchor.imageUri);
    expect(request.metadata.seedIsDeterministic).toBe(false);
  });

  it("Lite recusa referenceImages e todos os modelos limitam a três", () => {
    expect(() => buildVeoUgcVideoRequest(videoRequest, ugcVeoPreset("economy"))).toThrow(/não suporta referenceImages/);
    expect(() => buildVeoUgcVideoRequest({ ...videoRequest, additionalReferenceUris: ["a", "b", "c", "d"] }, ugcVeoPreset("high"))).toThrow(/no máximo 3/);
  });
});

describe("providers futuros sem transporte de rede", () => {
  it("runtime REAL permanece desligado mesmo com modelos e preços configurados", () => {
    const factories = createUgcProviderFactories();
    expect(() => factories.reference(catalog.requireOne(ugcPricingRefs("high").reference), "real")).toThrow(/ainda não configurado/);
    expect(() => factories.video(catalog.requireOne(ugcPricingRefs("high").video), "real")).toThrow(/ainda não configurado/);
  });

  it("retoma por operation ID sem repetir submit e mantém polling/download separados", async () => {
    const calls = { submit: 0, poll: 0, download: 0 };
    const referenceTransport: GoogleUgcReferenceTransport = {
      submit: async request => { calls.submit++; expect(request.model).toBe(GEMINI_UGC_REFERENCE_MODEL); return { providerJobId: "operations/ref-1" }; },
      poll: async operationId => { calls.poll++; return { providerJobId: operationId, state: "succeeded" }; },
      download: async _operationId => { calls.download++; return { uri: "", data: new Uint8Array([1]), mimeType: "image/png", width: 720, height: 1280, billedUsage: { generations: 1 }, isMock: false }; },
    };
    const provider = new UgcReferenceProviderGoogle(catalog.requireOne(ugcPricingRefs("high").reference), referenceTransport);
    const operation = await provider.submit(referenceRequest);
    // Reinício lógico: só o operation ID é necessário; submit não é chamado de novo.
    const resumed = new UgcReferenceProviderGoogle(catalog.requireOne(ugcPricingRefs("high").reference), referenceTransport);
    await resumed.getStatus(operation);
    await resumed.downloadResult(operation);
    expect(calls).toEqual({ submit: 1, poll: 1, download: 1 });
  });

  it("Veo faz um submit por clique e nunca recebe áudio externo", async () => {
    let submitted = 0;
    const transport: VeoUgcVideoTransport = {
      submit: async request => { submitted++; expect(request.config.generateAudio).toBe(true); return { providerJobId: "operations/veo-1" }; },
      poll: async operationId => ({ providerJobId: operationId, state: "succeeded" }),
      download: async () => ({ uri: "", mimeType: "video/mp4", durationSeconds: 8, requestedDurationSeconds: 8, providerReportedDurationSeconds: 8, billedUsage: { seconds: 8 }, isMock: false, hasAudio: true }),
    };
    const provider = new UgcVideoProviderVeo(catalog.requireOne(ugcPricingRefs("high").video), transport);
    const operation = await provider.submit(videoRequest);
    await provider.getStatus(operation);
    expect((await provider.downloadResult(operation)).hasAudio).toBe(true);
    expect(submitted).toBe(1);
    expect(() => buildVeoUgcVideoRequest({ ...videoRequest, audio: { data: new Uint8Array(), startSeconds: 0, endSeconds: 1, narrationVersion: "v1" } }, ugcVeoPreset("high"))).toThrow(/áudio nativo/);
  });
});
