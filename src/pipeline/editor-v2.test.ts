import { describe, expect, it } from "vitest";
import { buildUgcVideoPrompt } from "@/ai/ugc-video-prompt";
import { buildUgcReferencePrompt } from "@/ai/ugc-script";
import { loadAppConfig } from "@/config/env";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { decideFidelity, deriveFidelityConstraints, fidelityPromptLines, findFidelityConflicts, initialFidelity } from "@/domain/fidelity";
import { CreativePlanSchema } from "@/domain/creative";
import { RenderManifestSchema } from "@/domain/render";
import { fidelityReleasesVideo, UgcReferenceSchema } from "@/domain/ugc";
import { createUgcProviderFactories } from "@/providers/ugc";
import { buildRenderManifest } from "@/render/manifest";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { product } from "@/test/fixtures";
import { PNG_1X1 } from "@/test/google-fake";
import { FAKE_KREA_KEY, kreaFake } from "@/test/krea-fake";
import { ugcHarness } from "@/test/ugc-harness";

const dryer = product({ name: "Secador Turbo SC-2100", description: "Secador de cabelo 2100W com bico concentrador.", features: ["2100W", "3 temperaturas", "Cabo de 1,8 m"], benefits: ["Seca rápido"] });

describe("Product Fidelity Gate — regras puras", () => {
  it("constraints vêm só dos dados do produto: números, modelo, nome, logo, cores, forma, botões", () => {
    const constraints = deriveFidelityConstraints(dryer);
    const exact = constraints.filter((c) => c.kind === "number" || c.kind === "model").map((c) => c.expected);
    expect(exact).toEqual(expect.arrayContaining(["2100W", "3 temperaturas", "1,8m", "SC-2100"]));
    expect(constraints.map((c) => c.kind)).toEqual(expect.arrayContaining(["text", "logo", "color", "shape", "buttons", "packaging"]));
    expect(fidelityPromptLines(constraints).join(" ")).toMatch(/"2100W"/);
  });

  it("2100W esperado × 3900 observado = conflito; números iguais não conflitam", () => {
    const constraints = deriveFidelityConstraints(dryer);
    expect(findFidelityConflicts(constraints, ["3900"])).toEqual([expect.objectContaining({ observed: "3900" })]);
    expect(findFidelityConflicts(constraints, ["2100W", "2100"])).toEqual([]);
  });

  it("status: pending por padrão; humano aprova; conflito vira needs_review; reprovar = rejected; nunca aprova sozinho", () => {
    const start = initialFidelity(deriveFidelityConstraints(dryer));
    expect(start.status).toBe("pending");
    expect(decideFidelity(start, { confirmed: true, reviewedAt: "t" })).toMatchObject({ status: "approved", checkedBy: "human" });
    expect(decideFidelity(start, { confirmed: true, observedTexts: ["3900"], reviewedAt: "t" })).toMatchObject({ status: "needs_review", checkedBy: "rules" });
    expect(decideFidelity(start, { confirmed: false, reviewedAt: "t" }).status).toBe("rejected");
  });

  it("gate: pendente bloqueia; aprovada libera; MOCK nunca libera REAL", () => {
    const pending = { isMock: false, fidelity: initialFidelity([]) };
    const approved = { isMock: false, fidelity: { ...initialFidelity([]), status: "approved" as const } };
    expect(fidelityReleasesVideo(pending, "real")).toBe(false);
    expect(fidelityReleasesVideo(approved, "real")).toBe(true);
    expect(fidelityReleasesVideo({ ...approved, isMock: true }, "real")).toBe(false);
    expect(fidelityReleasesVideo({ isMock: false }, "real")).toBe(false); // referência antiga sem revisão
  });
});

describe("prompts de realismo e continuidade", () => {
  it("referência: frame real de UGC, sem texto/slogan/números inventados, com fidelidade explícita", () => {
    const identity = resolveUgcIdentity({ id: "c", revision: 1, product: dryer, request: { presenter: "woman", environment: "bathroom", visualStyle: "natural_smartphone" } });
    const anchor = productAnchor({ ...dryer, images: [{ id: "img_1", uri: "outputs/uploads/p/img_1.png" }] })!;
    const prompt = buildUgcReferencePrompt(identity, anchor, fidelityPromptLines(anchor.fidelityConstraints!));
    expect(prompt).toMatch(/not a posed ad/);
    expect(prompt).toMatch(/no slogans/);
    expect(prompt).toMatch(/no invented numbers/);
    expect(prompt).toMatch(/"2100W"/);
  });

  it("vídeo: smartphone real, micro movimentos, continuidade da cena anterior e lista do que evitar", () => {
    const prompt = buildUgcVideoPrompt({
      action: "the person turns the product slowly", speech: "Olha de perto.",
      continuity: { entryPose: "raises the product slightly from chest toward the camera", exitPose: "product turned to show its side", productHand: "right", productPosition: "chest", cameraDistance: "medium_close", eyeDirection: "product_then_camera", presenterPosition: "center" },
      fidelity: ["Keep the brand logo exactly."],
    });
    expect(prompt).toMatch(/smartphone video filmed at home/);
    expect(prompt).toMatch(/Starts exactly where the previous shot ended: the person raises the product/);
    expect(prompt).toMatch(/Ends with the person: product turned/);
    expect(prompt).toMatch(/Avoid: commercial studio look, presenter or avatar look/);
    expect(prompt).toMatch(/Brazilian Portuguese/);
  });
});

describe("Editor V2 no pipeline (Krea com fetch falso, zero rede)", () => {
  const env = { KREA_API_KEY: FAKE_KREA_KEY, UGC_PROVIDER: "krea", UGC_REAL_ALLOWED: "true" };
  async function harness() {
    const fake = kreaFake();
    const ugcProviders = createUgcProviderFactories({ krea: {
      apiKey: FAKE_KREA_KEY, readiness: kreaUgcReadiness(loadAppConfig(env), env), transport: fake.fetch,
      loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }),
    } });
    const h = await ugcHarness({ modes: { ugc_reference: "real", ugc_video: "real" }, ugcProviders, deps: { ugcChoice: kreaUgcPricingRefs }, request: { budget: { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false } } });
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const reference = (await h.service.getJob(h.jobId)).ugc!.references.at(-1)!;
    return { ...h, fake, reference };
  }

  it("referência nasce com fidelidade pendente; aprovar sem confirmar é recusado e nada é gerado", async () => {
    const h = await harness();
    expect(h.reference.fidelity).toMatchObject({ status: "pending" });
    expect(h.reference.fidelity!.constraints.length).toBeGreaterThan(0);
    await expect(h.service.approveUgcReference(h.jobId, h.reference.id)).rejects.toThrow(/fiéis/);
    expect(h.fake.posts("video")).toBe(0);
  });

  it("conflito conhecido (texto divergente) não segue automaticamente: needs_review e nenhum vídeo", async () => {
    const h = await harness();
    await expect(h.service.approveUgcReference(h.jobId, h.reference.id, { fidelityConfirmed: true, observedTexts: ["3900"] })).rejects.toThrow(/observado 3900/);
    const job = await h.service.getJob(h.jobId);
    expect(job.ugc!.references.at(-1)).toMatchObject({ review: "pending", fidelity: { status: "needs_review" } });
    expect((await h.service.quoteStage(h.jobId, "ugc_video")).ready).toBe(false);
    expect(h.fake.posts("video")).toBe(0);
  });

  it("fidelidade aprovada libera: continuidade e fidelidade chegam ao prompt Veo; render V2 usa só o áudio do A-roll", async () => {
    const h = await harness();
    const resumed = await h.service.approveUgcReference(h.jobId, h.reference.id, { fidelityConfirmed: true });
    expect((await resumed.completion!).kind).not.toBe("FAILED");
    const posts = h.fake.calls.filter((c) => c.method === "POST" && c.url.includes("/generate/video/"));
    const plan = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!;
    const arolls = plan.scenes.filter((s) => s.edit?.role === "aroll");
    expect(posts).toHaveLength(arolls.length); // B-roll de detalhe não gera POST
    expect(String(posts[1]!.body!.prompt)).toContain(`Starts exactly where the previous shot ended: the person ${arolls[0]!.edit!.continuity!.exitPose}`);
    expect(String(posts[0]!.body!.prompt)).toMatch(/Never invent or add numbers|must read exactly/);
    const job = await h.service.getJob(h.jobId);
    const edit = job.manifest!.edit!;
    expect(edit.version).toBe(2);
    expect(edit.audio.map((a) => a.sceneId)).toEqual(arolls.map((s) => s.id));
    expect(edit.visuals.filter((v) => v.role === "broll").every((v) => v.media === "image" && v.uri === job.ugc!.references.at(-1)!.imageUri)).toBe(true);
    // Custo continua pelo GERADO (8s); o corte usa menos.
    const ledger = (await new FileCostLedger(h.config.dataDir).list({ jobId: h.jobId })).filter((e) => e.category === "ugc_scene");
    expect(ledger.every((e) => e.quantity === 8)).toBe(true);
    expect(edit.usage.filter((u) => u.role === "aroll").every((u) => u.generatedSeconds === 8 && u.usedSeconds < 8)).toBe(true);
  });
});

describe("compatibilidade com dados antigos", () => {
  it("plano sem metadados editoriais, referência sem fidelidade e manifest sem edit continuam válidos", () => {
    const old = { id: "c1", productId: "p", concept: { id: "k", title: "t", angle: "a", hook: "h", targetEmotion: "e", format: "ugc", description: "d" }, duration: 4, hook: "h", script: "s", callToAction: "cta",
      scenes: [{ id: "s1", order: 0, duration: 4, narration: "Olá", onScreenText: "", visualDescription: "v", generationPrompt: "", shotType: "medium", visualSource: "product_image", motion: "ken_burns", requiresGeneratedVideo: false, estimatedGenerationSeconds: 0 }] };
    const plan = CreativePlanSchema.parse(old);
    expect(plan.editPlanVersion).toBeUndefined();
    const manifest = buildRenderManifest({ campaignId: "camp", plan, product: product(), sceneVideos: new Map(), outputDir: "outputs" });
    expect(RenderManifestSchema.parse(manifest).edit).toBeUndefined();
    expect(UgcReferenceSchema.parse({ id: "r", version: "v1", state: "succeeded", review: "approved", identityId: "c", identityRevision: 1, provider: "krea", model: "m", isMock: false, prompt: "p",
      product: { imageId: "i", imageUri: "u", name: "n", description: "", preserve: ["x"] }, estimatedCostUsd: 0.08, createdAt: "t" }).fidelity).toBeUndefined();
  });

  it("projeto antigo com referência aprovada SEM revisão de fidelidade: vídeo bloqueado até confirmar", async () => {
    const h = await ugcHarness();
    await h.run();
    const job = await h.service.getJob(h.jobId);
    const ref = job.ugc!.references.at(-1)!;
    // Simula dado antigo: aprovada antes do Lote 5.6, sem `fidelity`.
    const legacy = { ...ref, fidelity: undefined };
    await h.service["deps"].store.saveJob({ ...job, ugc: { ...job.ugc!, references: [{ ...legacy, review: "approved" }] } });
    expect((await h.service.quoteStage(h.jobId, "ugc_video")).blocked).toMatch(/fiéis/);
    const confirmed = await h.service.approveUgcReference(h.jobId, ref.id, { fidelityConfirmed: true });
    expect((await h.service.getJob(h.jobId)).ugc!.references.at(-1)!.fidelity!.status).toBe("approved");
    expect(confirmed.job.id).toBe(h.jobId);
  });
});
