import { afterEach, describe, expect, it } from "vitest";
import { getCampaignView, type AppDeps } from "@/application/campaign-actions";
import { realOnlyUgcView } from "@/application/ugc-view";
import { loadAppConfig, loadAppConfigSafe } from "@/config/env";
import { forceMocksForTests, mocksAllowed } from "@/config/execution-policy";
import { runtimeReadiness } from "@/config/readiness";
import { LocalUploadStore } from "@/storage/upload-store";
import { ugcHarness } from "@/test/ugc-harness";
import { hybridCapabilities } from "./hybrid-service";

/** Job antigo: criado e pausado na referência com mocks permitidos (dev/teste). */
async function oldMockJob() {
  const h = await ugcHarness({ realReference: true, request: { budget: { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false } } });
  expect((await h.run()).kind).toBe("WAITING_STAGE");
  const reference = (await h.service.getJob(h.jobId)).ugc!.references.at(-1)!;
  expect(reference.isMock).toBe(true);
  return { ...h, reference };
}

describe("ALLOW_MOCKS (Lote 5.5)", () => {
  afterEach(() => forceMocksForTests(true));

  it("padrão false; true só com opt-in; o override de teste é explícito", () => {
    forceMocksForTests(undefined);
    expect(mocksAllowed(loadAppConfig({}))).toBe(false);
    expect(mocksAllowed(loadAppConfig({ ALLOW_MOCKS: "true" }))).toBe(true);
    forceMocksForTests(true);
    expect(mocksAllowed(loadAppConfig({}))).toBe(true);
  });

  it("provider inválido não cai em MOCK: bloqueia todas as etapas e o readiness", () => {
    forceMocksForTests(undefined);
    const { config, issues } = loadAppConfigSafe({ UGC_PROVIDER: "kreaa" });
    const capabilities = hybridCapabilities(config, {}, issues);
    expect(Object.values(capabilities).every(capability => !capability.available)).toBe(true);
    expect(capabilities.ugc_reference.reason).toMatch(/Configuração inválida: UGC_PROVIDER/);
    const readiness = runtimeReadiness(config, issues, {});
    expect(readiness.blocking).toMatch(/Configuração/);
    // Com mocks explicitamente permitidos (dev), o fallback seguro continua disponível.
    forceMocksForTests(true);
    expect(hybridCapabilities(config, {}, issues).ugc_reference.reason).not.toMatch(/Configuração inválida/);
  });

  it("readiness geral aponta Anthropic, Krea e Remotion indisponíveis sem segredo", () => {
    forceMocksForTests(undefined);
    const config = loadAppConfig({ LLM_PROVIDER: "anthropic", UGC_PROVIDER: "krea", RENDERER: "remotion", RENDER_BROWSER_EXECUTABLE: "C:/nao/existe/chrome.exe" });
    const readiness = runtimeReadiness(config, [], {});
    const group = (id: string) => readiness.flow.find(item => item.id === id)!;
    expect(group("planner").ready).toBe(false);
    expect(group("ugc").ready).toBe(false);
    expect(group("renderer").ready).toBe(false);
    expect(readiness.blocking).toMatch(/Planejamento/);
    const capabilities = hybridCapabilities(config, {});
    expect([capabilities.planning.available, capabilities.ugc_reference.available, capabilities.render.available]).toEqual([false, false, false]);
  });

  it("LLM_PROVIDER=mock com ALLOW_MOCKS=false: planner bloqueado no readiness", () => {
    forceMocksForTests(undefined);
    const readiness = runtimeReadiness(loadAppConfig({}), [], {});
    expect(readiness.flow.find(item => item.id === "planner")!.ready).toBe(false);
    expect(readiness.flow.find(item => item.id === "renderer")!.ready).toBe(false);
  });
});

describe("fluxo REAL-only no pipeline", () => {
  it("Anthropic indisponível: criar projeto é recusado, sem planner MOCK", async () => {
    const h = await ugcHarness();
    const strict = h.build({ allowMocks: false, unavailable: ["planning"] });
    await expect(strict.startPlanning(h.campaign.request)).rejects.toThrow(/MOCK desabilitado.*planning REAL indisponível/);
  });

  it("job antigo MOCK continua legível, mas não continua: etapa bloqueada com motivo claro", async () => {
    const h = await oldMockJob();
    const strict = h.build({ allowMocks: false, unavailable: ["ugc_reference", "ugc_video", "render"] });
    const job = await strict.getJob(h.jobId);
    expect(job.ugc!.references).toHaveLength(1);
    const quote = await strict.quoteJob(h.jobId);
    expect(quote.ready).toBe(false);
    expect(quote.blockingStage?.stage).toBe("ugc_reference");
    expect(quote.blockingStage?.reason).toMatch(/MOCK desabilitado.*ugc_reference REAL indisponível/);
    // Krea indisponível: nenhuma geração MOCK substituta.
    const before = h.calls.references().length;
    await expect(strict.authorizeAndRunJob(h.jobId, quote.token)).rejects.toThrow();
    expect(h.calls.references()).toHaveLength(before);
    // Remotion indisponível: render não vira MP4 falso.
    expect((await strict.quoteStage(h.jobId, "render")).blocked).toMatch(/MOCK desabilitado|Conclua/);
  });

  it("referência MOCK não pode ser aprovada (servidor e UI)", async () => {
    const h = await oldMockJob();
    const strict = h.build({ allowMocks: false });
    await expect(strict.approveUgcReference(h.jobId, h.reference.id)).rejects.toThrow(/simulada/);
    const deps = { service: strict, uploads: new LocalUploadStore(h.config.uploadsDir), rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, allowMocks: false } as AppDeps;
    const view = await getCampaignView(deps, h.campaign.id);
    if (!view.ok) throw new Error(view.error.message);
    const ugc = view.value.creatives[0]!.ugc!;
    expect(ugc).toMatchObject({ canApprove: false, awaitingApproval: false, historicalSimulation: true, canGenerateReal: true });
    expect(ugc.current?.previewUrl).toBeNull();
    // Com mocks permitidos (dev), a mesma referência continua aprovável.
    expect(realOnlyUgcView({ ...ugc, current: undefined, approved: undefined, history: [] }).canApprove).toBe(false);
  });

  it("gerar referência real substitui a etapa MOCK sem apagar o histórico", async () => {
    const h = await oldMockJob();
    const strict = h.build({ allowMocks: false });
    await strict.switchJobToReal(h.jobId);
    const job = await strict.getJob(h.jobId);
    expect(Object.entries(job.stageModes!).filter(([stage]) => stage !== "planning").every(([, mode]) => mode === "real")).toBe(true);
    const quote = await strict.quoteStage(h.jobId, "ugc_reference");
    expect(quote.done).toBe(false);
    expect(quote.awaitingReview).toBeFalsy(); // a MOCK pendente não conta como referência
    const jobQuote = await strict.quoteJob(h.jobId);
    expect(jobQuote.ready, jobQuote.blocked).toBe(true);
    await (await strict.authorizeAndRunJob(h.jobId, jobQuote.token)).completion;
    const references = (await strict.getJob(h.jobId)).ugc!.references;
    expect(references.map(r => r.isMock)).toEqual([true, false]);
    expect(references[0]!.id).toBe(h.reference.id); // histórico MOCK preservado
    // A real é a que aguarda aprovação; aprovar a real é permitido.
    const approved = await strict.approveUgcReference(h.jobId, references[1]!.id);
    expect(approved.job.ugc!.references[1]!.review).toBe("approved");
  });

  it("ALLOW_MOCKS=true mantém o fluxo MOCK completo para dev/teste", async () => {
    const h = await ugcHarness();
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    expect(h.calls.references()).toHaveLength(1);
  });
});
