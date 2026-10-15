import { assertRealCallsEnabled } from "../src/config/execution-policy";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { AvatarPresetSchema } from "../src/domain/presenter";
import { loadAppConfig } from "../src/config/env";
import { createPipelineService } from "../src/pipeline/create-pipeline-service";
import { durationReport } from "../src/domain/media-integrity";
async function main() {
  if (process.argv.includes("--confirm")) assertRealCallsEnabled();
  const { values } = parseArgs({ options: { job: { type: "string" }, scene: { type: "string" }, avatar: { type: "string", default: "influencer" }, confirm: { type: "boolean", default: false }, resume: { type: "boolean", default: false } }, strict: true });
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!values.job) throw new Error("Informe --job com o ID do job que possui narration.mp3 e alignment reais.");
  const avatar = AvatarPresetSchema.parse(values.avatar);
  const config = loadAppConfig();
  const service = createPipelineService({ ...config, storage: "file", llmProvider: "mock", videoProvider: "mock", audioProvider: "mock", renderer: { ...config.renderer, id: "mock" } });
  if (values.resume) {
    const job = await service.getJob(values.job);
    const task = job.presenterTasks?.find(t => t.state === "pending" && t.providerJobId);
    if (!task) throw new Error("Nenhuma tarefa presenter confirmada para retomar sem novo POST.");
    console.log(`Retomar ${task.providerJobId} · avatar ${task.avatarPresetId} · gwm1_avatars · ${task.requestedDurationSeconds}s · áudio ${task.audio.narrationVersion} ${task.audio.startSeconds}s → ${task.audio.endSeconds}s · estimativa original US$${task.estimatedCostUsd.toFixed(4)}`);
    if (!values.confirm) { console.log("Dry-run de retomada: nenhuma chamada/gravação. Use --resume --confirm para polling/download sem novo POST pago."); return; }
    if (job.scenes.some(s => s.requiresGeneratedVideo && !s.attempts.some(a => a.active && a.status === "succeeded") && !job.presenterTasks?.some(t => t.sceneId === s.sceneId && t.state === "pending" && t.providerJobId))) throw new Error("Retomada da CLI exige todas as cenas já geradas ou com tarefa presenter pendente; nenhuma geração nova autorizada.");
    const outcome = await (await service.startRerender(job.id)).completion;
    if (outcome.kind !== "COMPLETED") throw new Error(outcome.job.error ?? (outcome.kind === "FAILED" ? outcome.error : outcome.kind));
    console.log(`Concluído ${job.id}; somente polling/download. Sem novo POST.`); return;
  }
  const preview = await service.previewPresenterValidation(values.job, avatar, values.scene);
  console.log(`Avatar ${avatar} · modelo ${preview.model} · ${preview.durationSeconds.toFixed(3)}s · estimativa US$${preview.estimate.costUsd.toFixed(4)} (≈ R$${(preview.estimate.costUsd * config.exchangeRate.rate).toFixed(2)})`);
  console.log(`Áudio existente: ${preview.audioPath} · versão ${preview.audio.narrationVersion} · cena ${preview.sceneId} · intervalo ${preview.window.startSeconds}s → ${preview.window.endSeconds}s`);
  if (!values.confirm) { console.log("Dry-run: nenhuma chamada, nenhum arquivo gravado. --confirm autoriza UMA geração de avatar; nenhuma voz nova."); return; }
  const job = await service.preparePresenterValidation(values.job, avatar, values.scene);
  console.log(`Validação isolada · job ${job.id} · campanha ${job.campaignId} · origem preservada`);
  await service.requestApproval(job.id);
  const approval = await service.approve(job.id, { estimateId: job.estimate!.id });
  if (approval.kind !== "APPROVED") throw new Error("Orçamento excedido; nenhuma chamada ao avatar.");
  const outcome = await service.generate(job.id);
  const stored = await service.getJob(job.id);
  const attempt = stored.scenes.flatMap(s => s.attempts).find(a => a.presenter);
  console.log(durationReport(attempt?.media));
  if (outcome.kind !== "COMPLETED") throw new Error(outcome.kind === "FAILED" ? outcome.error : outcome.kind);
  console.log(`Clipe: ${attempt?.assetUri} · providerJobId ${attempt?.providerJobId} · requestId ${attempt?.requestId ?? "indisponível"}. Custo no ledger; render final mock.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Falha na validação presenter"); process.exitCode = 1; });
