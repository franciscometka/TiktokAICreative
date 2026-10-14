import { describe, expect, it } from "vitest";
import type { RenderManifest } from "@/domain/render";
import type { Renderer, RenderOptions, RenderResult } from "@/render/renderer";
import { BUDGET, campaignRequest, createHarness, type HarnessOptions } from "@/test/fixtures";
import { UnexpectedStatusError } from "./guards";
import { JobInProgressError } from "./pipeline-service";

/** Renderer "real" falso: grava versões, informa progresso e só termina quando liberado. */
class ControlledRenderer implements Renderer {
  readonly id = "remotion";
  readonly isMock = false;
  calls: { manifest: RenderManifest; options?: RenderOptions }[] = [];
  failNext = false;
  private gates: (() => void)[] = [];
  private version = 0;

  async render(manifest: RenderManifest, options?: RenderOptions): Promise<RenderResult> {
    this.calls.push({ manifest, options });
    options?.onProgress?.({ renderedFrames: 120, totalFrames: 750 });
    await new Promise<void>((resolve) => this.gates.push(resolve));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Chrome fechou no meio do render");
    }
    this.version = Math.max(this.version + 1, options?.preferredVersion ?? 1);
    const renderId = `v${this.version}`;
    return {
      outputUri: `outputs/renders/${manifest.campaignId}/${manifest.creativeId}/${renderId}/final.mp4`,
      manifestUri: `outputs/renders/${manifest.campaignId}/${manifest.creativeId}/${renderId}/manifest.json`,
      isMock: false,
      usage: { generations: 1 },
      renderId,
      sizeBytes: 1_234_567,
      durationSeconds: manifest.duration,
      totalFrames: manifest.duration * 30,
      renderMs: 4200,
      warnings: [...manifest.warnings, { sceneId: null, code: "audio_unavailable", message: "Sem narração real." }],
    };
  }

  release(): void {
    this.gates.shift()?.();
  }

  async waitForCall(n: number): Promise<void> {
    for (let i = 0; i < 200 && (this.calls.length < n || this.gates.length === 0); i++) await new Promise((r) => setTimeout(r, 5));
    if (this.calls.length < n) throw new Error(`render ${n} não começou`);
  }
}

function setup(options: HarnessOptions = {}) {
  const renderer = new ControlledRenderer();
  const h = createHarness({ renderer, ...options });
  return { h, renderer };
}

async function approvedJob(h: ReturnType<typeof createHarness>) {
  const campaign = await h.service.planCampaign(campaignRequest({ budget: BUDGET }));
  const jobId = campaign.jobIds[0]!;
  const estimated = await h.service.estimateCost(jobId);
  await h.service.requestApproval(jobId);
  await h.service.approve(jobId, { estimateId: estimated.estimate!.id });
  return jobId;
}

describe("render em segundo plano", () => {
  it("rendering → completed com registro persistido, progresso real e custo local R$0", async () => {
    const { h, renderer } = setup();
    const jobId = await approvedJob(h);
    const { completion } = await h.service.startGeneration(jobId);

    await renderer.waitForCall(1);
    const during = await h.store.getJob(jobId);
    expect(during.status).toBe("rendering");
    expect(during.renders).toHaveLength(1);
    expect(during.renders[0]).toMatchObject({ status: "rendering", renderer: "remotion", isMock: false });
    expect(h.service.isJobActive(jobId)).toBe(true);
    expect(h.service.isJobInterrupted(during)).toBe(false);
    expect(h.service.getRenderProgress(jobId)).toEqual({ renderedFrames: 120, totalFrames: 750 });

    renderer.release();
    expect((await completion).kind).toBe("COMPLETED");

    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("completed");
    expect(job.outputUri).toBe(`outputs/renders/${job.campaignId}/${job.creativeId}/v1/final.mp4`);
    expect(job.renders[0]).toMatchObject({
      status: "completed",
      renderId: "v1",
      manifestUri: expect.stringMatching(/v1\/manifest\.json$/),
      sizeBytes: 1_234_567,
      renderMs: 4200,
      finishedAt: expect.any(String),
    });
    // Avisos do manifest (placeholder de IA) + do renderer (sem áudio) ficam no registro.
    const codes = job.renders[0]!.warnings.map((w) => w.code);
    expect(codes).toContain("audio_unavailable");
    expect(job.manifest?.campaignId).toBe(job.campaignId);
    expect(h.service.isJobActive(jobId)).toBe(false);
    expect(h.service.getRenderProgress(jobId)).toBeUndefined();

    const renderCosts = (await h.ledger.list({ jobId })).filter((e) => e.category === "rendering");
    expect(renderCosts).toHaveLength(1);
    expect(renderCosts[0]).toMatchObject({ costBrl: 0, simulated: false });
  });

  it("não aceita segunda ação enquanto o job está ativo", async () => {
    const { h, renderer } = setup();
    const jobId = await approvedJob(h);
    const { completion } = await h.service.startGeneration(jobId);
    await renderer.waitForCall(1);
    await expect(h.service.startRerender(jobId)).rejects.toBeInstanceOf(JobInProgressError);
    renderer.release();
    await completion;
  });

  it("falha do render → failed com erro registrado, sem nova tentativa automática", async () => {
    const { h, renderer } = setup();
    const jobId = await approvedJob(h);
    renderer.failNext = true;
    const { completion } = await h.service.startGeneration(jobId);
    await renderer.waitForCall(1);
    renderer.release();
    const outcome = await completion;
    expect(outcome.kind).toBe("FAILED");

    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("Chrome fechou");
    expect(job.renders[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Chrome fechou") });
    expect(renderer.calls).toHaveLength(1);
    // Mídia já paga continua ativa: renderizar de novo NÃO gera vídeo/áudio de novo.
    const videoCalls = h.video.generateCalls.length;

    const retry = await h.service.startRerender(jobId);
    expect(retry.job.status).toBe("rendering");
    await renderer.waitForCall(2);
    renderer.release();
    expect((await retry.completion).kind).toBe("COMPLETED");
    expect(h.video.generateCalls).toHaveLength(videoCalls);
    const after = await h.store.getJob(jobId);
    expect(after.renders.map((r) => r.status)).toEqual(["failed", "completed"]);
  });

  it("renderizar novamente cria nova versão e mantém a anterior", async () => {
    const { h, renderer } = setup();
    const jobId = await approvedJob(h);
    const first = await h.service.startGeneration(jobId);
    await renderer.waitForCall(1);
    renderer.release();
    await first.completion;

    const again = await h.service.startRerender(jobId);
    await renderer.waitForCall(2);
    expect(renderer.calls[1]?.options?.preferredVersion).toBe(2);
    renderer.release();
    await again.completion;

    const job = await h.store.getJob(jobId);
    expect(job.renders.map((r) => r.renderId)).toEqual(["v1", "v2"]);
    expect(job.outputUri).toMatch(/\/v2\/final\.mp4$/);
  });

  it("render interrompido (processo reiniciou) não recomeça sozinho; só com ação explícita", async () => {
    const { h, renderer } = setup();
    const jobId = await approvedJob(h);
    const { completion } = await h.service.startGeneration(jobId);
    await renderer.waitForCall(1);

    // "Reinício": outro PipelineService sobre o mesmo armazenamento, sem execução ativa.
    const fresh = new ControlledRenderer();
    const restarted = createHarness({ renderer: fresh, ids: h.ids, storage: { store: h.store, ledger: h.ledger, llmCallLog: h.llmCallLog } });
    const stuck = await restarted.store.getJob(jobId);
    expect(stuck.status).toBe("rendering");
    expect(restarted.service.isJobInterrupted(stuck)).toBe(true);
    expect(fresh.calls).toHaveLength(0);

    const retry = await restarted.service.startRerender(jobId);
    await fresh.waitForCall(1);
    fresh.release();
    expect((await retry.completion).kind).toBe("COMPLETED");
    const job = await restarted.store.getJob(jobId);
    expect(job.renders[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Interrompido") });
    expect(job.renders[1]).toMatchObject({ status: "completed" });

    renderer.release();
    await completion.catch(() => undefined);
  });

  it("não renderiza de novo se a mídia não terminou", async () => {
    const { h } = setup({ video: { failSceneIds: new Set(["scene_1"]) } });
    const jobId = await approvedJob(h);
    const { completion } = await h.service.startGeneration(jobId);
    expect((await completion).kind).toBe("FAILED");
    await expect(h.service.startRerender(jobId)).rejects.toBeInstanceOf(UnexpectedStatusError);
  });
});
