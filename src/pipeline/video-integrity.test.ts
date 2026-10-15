import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { checkClipDuration, durationReport } from "@/domain/media-integrity";
import { inspectMp4 } from "@/providers/video/mp4";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { LocalVideoAssetStore } from "@/storage/video-asset-store";
import { campaignRequest, createHarness, product } from "@/test/fixtures";
import { makeMp4 } from "@/test/mp4-fixture";
import { runwayFixture } from "@/test/runway-fake";

async function generate(clip: Uint8Array) {
  const fake = await runwayFixture({ clip });
  const h = createHarness({
    storage: { store: new FilePipelineStore(join(fake.root, "data")), ledger: new FileCostLedger(join(fake.root, "data")), llmCallLog: new InMemoryLlmCallLog() },
    videoChoice: RUNWAY_VIDEO,
    videoProvider: () => fake.provider,
    videoAssets: new LocalVideoAssetStore(join(fake.root, "videos")),
  });
  const campaign = await h.service.planCampaign(campaignRequest({ product: product({ images: [{ id: "img_1", uri: fake.request.referenceImageUris[0]! }] }) }));
  const jobId = campaign.jobIds[0]!;
  const estimated = await h.service.estimateCost(jobId);
  await h.service.requestApproval(jobId);
  expect((await h.service.approve(jobId, { estimateId: estimated.estimate!.id })).kind).toBe("APPROVED");
  const outcome = await h.service.generate(jobId);
  const job = await h.store.getJob(jobId);
  const videoCosts = (await h.ledger.list({ jobId })).filter((e) => e.category === "video");
  return { h, fake, jobId, outcome, job, videoCosts };
}

describe("leitura da duração real do MP4", () => {
  it("lê a trilha de vídeo (mdhd), detecta arquivo cortado e não-MP4", () => {
    expect(inspectMp4(makeMp4(5))).toEqual({ complete: true, durationSeconds: 5, hasVideoTrack: true });
    const cut = makeMp4(5, { mdatBytes: 4000 }).subarray(0, 2000);
    expect(inspectMp4(cut)).toMatchObject({ complete: false, durationSeconds: undefined });
    expect(inspectMp4(new TextEncoder().encode("<html>expirou</html>"))).toMatchObject({ complete: false, durationSeconds: undefined });
    // Trilha de vídeo vale mais que o cabeçalho do filme (metadata divergente).
    expect(inspectMp4(makeMp4(1, { movieSeconds: 5 })).durationSeconds).toBe(1);
  });
});

describe("checkClipDuration (pura)", () => {
  it("correto dentro da tolerância (Runway entrega 5,042s para 5s)", () => {
    expect(checkClipDuration({ requestedSeconds: 5, actualSeconds: 5.042, fileComplete: true })).toMatchObject({ status: "valid", toleranceSeconds: 0.25 });
  });
  it("truncado, longo demais, incompleto e ilegível", () => {
    expect(checkClipDuration({ requestedSeconds: 5, actualSeconds: 1, fileComplete: true }).status).toBe("truncated");
    expect(checkClipDuration({ requestedSeconds: 5, actualSeconds: 9, fileComplete: true }).status).toBe("too_long");
    expect(checkClipDuration({ requestedSeconds: 5, actualSeconds: 5, fileComplete: false }).status).toBe("incomplete_file");
    expect(checkClipDuration({ requestedSeconds: 5, actualSeconds: undefined, fileComplete: true }).status).toBe("unreadable");
  });
  it("metadata do provider divergente: vale a medida do arquivo; divergência fica registrada", () => {
    const check = checkClipDuration({ requestedSeconds: 5, providerReportedSeconds: 5, actualSeconds: 1, fileComplete: true });
    expect(check).toMatchObject({ status: "truncated", providerReportedDurationSeconds: 5, actualMediaDurationSeconds: 1, providerMismatch: true });
    expect(durationReport(check)).toBe("solicitado: 5.00s\nprovider: 5.00s\narquivo real: 1.00s — REJEITADO (truncated)");
  });
});

describe("pipeline: integridade do clipe real (Runway falso, sem internet)", () => {
  it("duração correta: clipe aceito com as três durações persistidas separadamente", async () => {
    const { outcome, job } = await generate(makeMp4(5.042));
    expect(outcome.kind).toBe("COMPLETED");
    const attempt = job.scenes[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ status: "succeeded", active: true, durationSeconds: 5.042 });
    expect(attempt.media).toMatchObject({ requestedDurationSeconds: 5, actualMediaDurationSeconds: 5.042, status: "valid" });
    expect(attempt.media?.providerReportedDurationSeconds).toBeUndefined();
    const integrity = JSON.parse(await readFile(join(attempt.assetUri!, "..", "integrity.json"), "utf8"));
    expect(integrity).toMatchObject({ requestedDurationSeconds: 5, actualMediaDurationSeconds: 5.042, status: "valid" });
  });

  it("clipe truncado (~1s): rejeitado, custo PRESERVADO, sem retry, fora do render, erro claro", async () => {
    const { h, fake, outcome, job, videoCosts } = await generate(makeMp4(1));
    expect(outcome.kind).toBe("FAILED");
    expect(job.status).toBe("failed");
    const attempt = job.scenes[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ status: "failed", active: false, media: { status: "truncated", requestedDurationSeconds: 5, actualMediaDurationSeconds: 1 } });
    expect(attempt.assetUri).toBeUndefined();
    expect(attempt.rejectedAssetUri).toContain("/v1/clip.mp4");
    expect(job.error).toMatch(/Clipe da cena 1 rejeitado: o arquivo é mais curto que o solicitado \(solicitado 5,00s, provider indisponível, arquivo real 1,00s/);
    expect(job.error).toMatch(/Custo preservado/);
    // Custo da tentativa continua no ledger (uma vez) e entra no total real.
    expect(videoCosts).toHaveLength(1);
    expect(videoCosts[0]).toMatchObject({ attemptId: attempt.id, simulated: false, costUsd: 0.25 });
    expect((await h.service.getJobCostReport(job.id)).actual.discardedBrl).toBeGreaterThan(0);
    // Uma única criação paga; nenhuma nova tentativa automática.
    expect(fake.calls.filter((c) => c.url.endsWith("/image_to_video"))).toHaveLength(1);
    // Nunca vai ao Remotion: não há manifest/render com o clipe.
    expect(job.manifest).toBeUndefined();
    expect(job.renders).toHaveLength(0);
  });

  it("arquivo inválido (MP4 sem moov / cortado): rejeitado como incompleto, custo preservado", async () => {
    const broken = makeMp4(5, { mdatBytes: 4000 }).subarray(0, 3000);
    const { outcome, job, videoCosts } = await generate(broken);
    expect(outcome.kind).toBe("FAILED");
    expect(job.scenes[0]!.attempts[0]!.media?.status).toBe("incomplete_file");
    expect(job.error).toMatch(/arquivo está incompleto/);
    expect(videoCosts).toHaveLength(1);
  });

  it("metadata divergente dentro do MP4 (filme 5s, trilha 1s): vale a trilha → rejeitado", async () => {
    const { outcome, job } = await generate(makeMp4(1, { movieSeconds: 5 }));
    expect(outcome.kind).toBe("FAILED");
    expect(job.scenes[0]!.attempts[0]!.media).toMatchObject({ status: "truncated", actualMediaDurationSeconds: 1 });
  });
});
