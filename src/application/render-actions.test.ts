import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { RenderManifest } from "@/domain/render";
import { allocateRenderDir, FINAL_FILE, MANIFEST_FILE, relativeRenderUri } from "@/render/output-paths";
import type { Renderer, RenderOptions, RenderResult } from "@/render/renderer";
import { formInput, GatedPlanner, settle, tempUploads, until } from "@/test/app-fixtures";
import { createHarness } from "@/test/fixtures";
import { approveCreative, getCampaignView, rerenderCreative, resolveRenderFile, startCampaignPlanning, type AppDeps } from "./campaign-actions";
import type { CampaignView } from "./campaign-view";

/** Renderer que grava um "MP4" de verdade em disco (versões v1, v2...), como o Remotion. */
class DiskRenderer implements Renderer {
  readonly id = "remotion";
  readonly isMock = false;
  failNext = false;
  constructor(private readonly rendersDir: string) {}

  async render(manifest: RenderManifest, options?: RenderOptions): Promise<RenderResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("FFmpeg encerrou com código 1");
    }
    const campaignId = manifest.campaignId!;
    const { renderId, dir } = await allocateRenderDir(this.rendersDir, campaignId, manifest.creativeId, options?.preferredVersion);
    await writeFile(join(dir, FINAL_FILE), Buffer.alloc(2048, 1));
    await writeFile(join(dir, MANIFEST_FILE), JSON.stringify({ renderId }));
    return {
      outputUri: relativeRenderUri(this.rendersDir, campaignId, manifest.creativeId, renderId, FINAL_FILE),
      manifestUri: relativeRenderUri(this.rendersDir, campaignId, manifest.creativeId, renderId, MANIFEST_FILE),
      isMock: false,
      usage: { generations: 1 },
      renderId,
      sizeBytes: 2048,
      durationSeconds: manifest.duration,
      totalFrames: manifest.duration * 30,
      renderMs: 1500,
      warnings: [...manifest.warnings, { sceneId: null, code: "audio_unavailable", message: "Sem narração real: vídeo sem som." }],
    };
  }
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`esperava sucesso: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function setup(options: { mockRenderer?: boolean } = {}) {
  const rendersDir = await mkdtemp(join(tmpdir(), "renders-app-"));
  const renderer = new DiskRenderer(rendersDir);
  let planner!: GatedPlanner;
  const h = createHarness({ planner: (gen) => (planner = new GatedPlanner(gen)), renderer: options.mockRenderer ? undefined : renderer });
  const { uploads } = await tempUploads();
  const deps: AppDeps = { service: h.service, uploads, rendersDir };
  const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
  planner.release();
  await settle();
  const view = async (): Promise<CampaignView> => ok(await getCampaignView(deps, campaignId));
  return { h, deps, renderer, rendersDir, campaignId, view };
}

async function renderedOnce() {
  const ctx = await setup();
  const creative = (await ctx.view()).creatives[0]!;
  ok(await approveCreative(ctx.deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId }));
  await until(async () => (await ctx.view()).creatives[0]?.jobStatus === "completed");
  return { ...ctx, jobId: creative.jobId!, creativeId: creative.id };
}

describe("render na UI: player, download e versões", () => {
  it("criativo renderizado expõe player e download por IDs, com avisos e sem caminho de disco", async () => {
    const { view, campaignId, creativeId } = await renderedOnce();
    const c = (await view()).creatives[0]!;
    expect(c.latestRender).toMatchObject({
      renderId: "v1",
      videoUrl: `/api/renders/${campaignId}/${creativeId}/v1`,
      downloadUrl: `/api/renders/${campaignId}/${creativeId}/v1?download=1`,
      sizeBytes: 2048,
      renderMs: 1500,
    });
    // Avisos persistidos no RenderRecord chegam à UI como texto.
    expect(c.latestRender?.warnings.some((w) => w.includes("sem som"))).toBe(true);
    expect(c.previousRenders).toEqual([]);
    expect(c.canRerender).toBe(true);
    expect(c.activity).toBeUndefined();
    expect(c.interrupted).toBe(false);
    // Nada de caminho de disco na view: o browser só conhece IDs.
    expect(JSON.stringify(c.latestRender)).not.toContain(FINAL_FILE);
    expect(JSON.stringify(c.latestRender)).not.toContain(tmpdir().replaceAll("\\", "\\\\"));
  });

  it("resolveRenderFile só entrega MP4 registrado no job, dentro da pasta de renders", async () => {
    const { deps, campaignId, creativeId, rendersDir } = await renderedOnce();
    const file = await resolveRenderFile(deps, { campaignId, creativeId, renderId: "v1" });
    expect(file).toMatchObject({ sizeBytes: 2048, fileName: `criativo-${creativeId}-v1.mp4` });
    expect(file!.absolutePath.startsWith(resolve(rendersDir) + sep)).toBe(true);

    // Arquivo existe no disco, mas a versão não está registrada no job → não é servido.
    await mkdir(join(rendersDir, campaignId, creativeId, "v9"), { recursive: true });
    await writeFile(join(rendersDir, campaignId, creativeId, "v9", FINAL_FILE), "x");
    expect(await resolveRenderFile(deps, { campaignId, creativeId, renderId: "v9" })).toBeUndefined();
  });

  it.each([
    ["..", "creative_1", "v1"],
    ["campaign_1", "../..", "v1"],
    ["campaign_1", "creative_1", "../v1"],
    ["campaign_1", "creative_1", "v0"],
    ["campaign_1", "creative_1", "final.mp4"],
    ["c%2F..", "creative_1", "v1"],
  ])("resolveRenderFile recusa IDs inválidos (%s/%s/%s)", async (campaignId, creativeId, renderId) => {
    const { deps } = await renderedOnce();
    expect(await resolveRenderFile(deps, { campaignId, creativeId, renderId })).toBeUndefined();
  });

  it("render do MockRenderer não tem player nem download", async () => {
    const ctx = await setup({ mockRenderer: true });
    const creative = (await ctx.view()).creatives[0]!;
    ok(await approveCreative(ctx.deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId }));
    await until(async () => (await ctx.view()).creatives[0]?.jobStatus === "completed");
    const c = (await ctx.view()).creatives[0]!;
    expect(c.latestRender).toBeUndefined();
    expect(c.result?.outputUri).toMatch(/^mock:\/\//);
  });

  it("job preso em 'rendering' após reinício aparece como Interrompido, sem atividade, com retomada explícita", async () => {
    const { h, deps, jobId } = await renderedOnce();
    const job = await h.store.getJob(jobId);
    await h.store.saveJob({ ...job, status: "rendering" }); // como se o processo tivesse caído no meio
    const restarted = createHarness({ renderer: new DiskRenderer(deps.rendersDir), ids: h.ids, storage: { store: h.store, ledger: h.ledger, llmCallLog: h.llmCallLog } });
    const c = ok(await getCampaignView({ ...deps, service: restarted.service }, job.campaignId)).creatives[0]!;
    expect(c.interrupted).toBe(true);
    expect(c.jobStatusLabel).toBe("Interrompido");
    expect(c.activity).toBeUndefined(); // nada de polling nem barra de progresso inventada
    expect(c.canRerender).toBe(true);
    expect(c.latestRender?.renderId).toBe("v1"); // a versão boa continua disponível
  });

  it("renderizar novamente cria v2, mantém v1 nas versões anteriores e mostra falha posterior", async () => {
    const { deps, view, jobId, renderer, campaignId, creativeId } = await renderedOnce();
    expect(ok(await rerenderCreative(deps, jobId))).toEqual({ kind: "started" });
    await until(async () => (await view()).creatives[0]?.latestRender?.renderId === "v2");
    let c = (await view()).creatives[0]!;
    expect(c.previousRenders.map((r) => r.renderId)).toEqual(["v1"]);
    expect(await resolveRenderFile(deps, { campaignId, creativeId, renderId: "v1" })).toBeDefined();

    renderer.failNext = true;
    ok(await rerenderCreative(deps, jobId));
    await until(async () => (await view()).creatives[0]?.jobStatus === "failed");
    c = (await view()).creatives[0]!;
    expect(c.lastRenderError).toContain("FFmpeg");
    // A última versão boa continua assistível; tentar de novo é explícito.
    expect(c.latestRender?.renderId).toBe("v2");
    expect(c.canRerender).toBe(true);
  });
});
