/**
 * Teste B (Lote 5.4): UMA cena Veo 3.1 a partir de uma referência do Teste A APROVADA visualmente.
 * Sem --confirm: nenhuma rede. Com --confirm: EXATAMENTE um POST (submit). `--resume <id>` retoma
 * polling/download pelo operation ID persistido, sem novo POST. Sem retry automático.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findUgcSpeechViolations, speechFitsDuration, UGC_ROLE_ACTIONS } from "../src/ai/ugc-script";
import { loadAppConfig } from "../src/config/env";
import { withRealStageAuthorization } from "../src/config/execution-policy";
import { PRICING_TABLE } from "../src/config/pricing";
import { veoConfigForPricingModel, veoRequestedDuration } from "../src/config/ugc-models";
import { googleUgcReadiness } from "../src/config/ugc-readiness";
import { buildActualCost, costForUsage } from "../src/costs/calculate";
import { StaticPricingCatalog } from "../src/costs/pricing-catalog";
import { checkClipDuration, durationReport } from "../src/domain/media-integrity";
import { UgcCharacterIdentitySchema, UgcProductAnchorSchema } from "../src/domain/ugc";
import { randomId } from "../src/lib/ids";
import { ugcInputHash } from "../src/pipeline/ugc-flow";
import { DEFAULT_POLL_OPTIONS, waitForCompletion } from "../src/providers/poll";
import { ProviderError } from "../src/providers/types";
import { createUgcProviderFactories } from "../src/providers/ugc";
import { buildVeoUgcVideoRequest } from "../src/providers/ugc/google-ugc-contract";
import { googleUgcRuntime } from "../src/providers/ugc/google-runtime";
import type { UgcVideoRequest } from "../src/providers/ugc/ugc-providers";
import { FileCostLedger } from "../src/storage/file-cost-ledger";
import { LocalVideoAssetStore } from "../src/storage/video-asset-store";
import { printReadiness, usd, ValidationIntentStore, type ValidationIntent } from "./ugc-validation";

const EDITORIAL_SECONDS = 8;

async function main() {
  const { values } = parseArgs({
    options: {
      reference: { type: "string" }, speech: { type: "string", default: "Olha isso aqui: repara no acabamento e no tamanho desse produto." },
      action: { type: "string", default: UGC_ROLE_ACTIONS.ugc_hook }, resume: { type: "string" }, confirm: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const config = loadAppConfig();
  const intents = new ValidationIntentStore(join(config.dataDir, "ugc-validation"));
  const pricing = new StaticPricingCatalog(PRICING_TABLE).requireOne({ provider: "google", model: config.ugc.videoModel });
  const model = veoConfigForPricingModel(pricing.model); // primeiro protocolo: 720p
  const resumed = values.resume ? await intents.get(values.resume) : undefined;
  if (values.resume && (!resumed || resumed.stage !== "ugc_video")) throw new Error("Intenção de vídeo não encontrada para --resume.");
  const referenceId = resumed?.referenceIntentId ?? values.reference;
  const reference = referenceId ? await intents.get(referenceId) : undefined;
  const speech = resumed?.inputs.speech ?? values.speech!;
  const action = resumed?.inputs.action ?? values.action!;
  const violations = findUgcSpeechViolations(speech);
  if (violations.length) throw new Error(`Fala recusada: ${violations.join("; ")}.`);
  if (!speechFitsDuration(speech, EDITORIAL_SECONDS)) throw new Error(`Fala longa demais para ${EDITORIAL_SECONDS}s.`);
  const extras = model.supportsReferenceImages && reference?.inputs.productUri ? [reference.inputs.productUri] : [];
  const seconds = veoRequestedDuration(EDITORIAL_SECONDS, model, extras.length);
  const estimated = costForUsage(pricing, { seconds }).costUsd;
  const readiness = googleUgcReadiness(config);

  console.log(`Teste B · cena AI UGC · ${model.model} · ${model.resolution} · ${model.aspectRatio} · ${seconds}s · áudio NATIVO do Veo (sem ElevenLabs)`);
  console.log(`Custo estimado: ${usd(estimated)} (≈ R$${(estimated * config.exchangeRate.rate).toFixed(2)}) · ${seconds}s × ${usd(pricing.priceUsd)}/s`);
  console.log(`Referência: ${reference ? `${reference.id} (${reference.approvedAt ? "aprovada" : "NÃO aprovada"}) ${reference.outputUri ?? ""}` : "(defina --reference <id do Teste A>)"}`);
  console.log(`Imagens extras: ${extras.length ? "produto original" : "nenhuma"} · seed: não usada (não determinística)`);
  console.log(`Fala: "${speech}" · Ação: ${action}`);
  printReadiness(readiness);
  if (!values.confirm) { console.log("Dry-run: nenhuma chamada, nenhum arquivo gravado. Use --confirm para autorizar EXATAMENTE UMA cena paga."); return; }
  if (!readiness.ready) throw new Error(readiness.reason);
  if (!reference || reference.stage !== "ugc_reference" || reference.status !== "succeeded" || !reference.outputUri) throw new Error("Teste B exige uma referência do Teste A gerada com sucesso (--reference <id>).");
  if (!reference.approvedAt) throw new Error(`Referência ${reference.id} ainda não aprovada visualmente. Rode: npm run ugc:reference:real -- --approve ${reference.id}`);
  const open = (await intents.unresolved("ugc_video")).filter(intent => intent.id !== resumed?.id);
  if (open.length) throw new Error(`Intenção ${open[0]!.id} sem desfecho (${open[0]!.status}). Retome com --resume ${open[0]!.id}; nenhum novo envio.`);
  if (resumed && resumed.status !== "submitted") throw new Error(`Intenção ${resumed.id} em ${resumed.status}: só operações com operation ID confirmado podem ser retomadas.`);

  const identity = UgcCharacterIdentitySchema.parse(JSON.parse(reference.inputs.identity ?? "{}"));
  const product = UgcProductAnchorSchema.parse(JSON.parse(reference.inputs.product ?? "{}"));
  const request: UgcVideoRequest = {
    sceneId: "scene_validation", role: "ugc_hook", reference: { id: reference.id, version: reference.inputs.referenceVersion ?? "v1", imageUri: reference.outputUri, approved: true },
    identity, product, speech, action, durationSeconds: EDITORIAL_SECONDS, aspectRatio: "9:16", ...(extras.length ? { additionalReferenceUris: extras } : {}),
  };
  const now = () => new Date().toISOString();
  const id = resumed?.id ?? randomId("ugcvid").replace(/-/g, "").slice(0, 40).toLowerCase();
  let intent: ValidationIntent = resumed ?? await intents.save({
    id, stage: "ugc_video", model: model.model, status: "preparing", maxCostUsd: estimated, estimatedCostUsd: estimated,
    inputHash: ugcInputHash(buildVeoUgcVideoRequest(request, model)), createdAt: now(), updatedAt: now(), referenceIntentId: reference.id,
    requestedDurationSeconds: seconds, inputs: { speech, action, referenceUri: reference.outputUri },
  });
  const provider = createUgcProviderFactories({ google: googleUgcRuntime(config) }).video(pricing, "real");
  const ledger = new FileCostLedger(config.dataDir);
  await withRealStageAuthorization("ugc_video", async () => {
    let ref = intent.operationId ? { providerJobId: intent.operationId } : undefined;
    if (!ref) {
      intent = await intents.save({ ...intent, status: "submitting", updatedAt: now() });
      try { ref = await provider.submit(request); }
      catch (error) {
        const diagnostic = error instanceof ProviderError ? error.diagnostic : undefined;
        const rejected = diagnostic?.billing === "rejected" || diagnostic?.operation === "none";
        await intents.save({ ...intent, status: rejected ? "failed" : "uncertain", error: error instanceof Error ? error.message : "falha", updatedAt: now() });
        throw error;
      }
      intent = await intents.save({ ...intent, status: "submitted", operationId: ref.providerJobId, updatedAt: now() });
      console.log(`Operação ${ref.providerJobId} persistida. Se o polling expirar: npm run ugc:video:real -- --resume ${id} --confirm`);
    }
    try {
      await waitForCompletion(r => provider.getStatus(r), ref, DEFAULT_POLL_OPTIONS);
    } catch (error) {
      if (error instanceof ProviderError && error.diagnostic?.operation === "created") {
        await intents.save({ ...intent, status: "failed", error: error.message, updatedAt: now() });
      } else console.error(`Polling sem desfecho; operação continua retomável: --resume ${id}`);
      throw error;
    }
    const result = await provider.downloadResult(ref);
    const billed = result.requestedDurationSeconds ?? intent.requestedDurationSeconds ?? seconds;
    const usage = result.billedUsage.seconds === undefined ? { seconds: billed } : result.billedUsage;
    await ledger.record(buildActualCost({
      id: `cost_${id}`, campaignId: "validation", jobId: id, creativeId: id, sceneId: "scene_validation", attemptId: id,
      operation: "ugc_video_generation", category: "ugc_scene", description: "Validação manual: cena AI UGC Veo",
      pricing, usage, exchangeRate: config.exchangeRate.rate, simulated: false, createdAt: now(),
    }));
    const stored = await new LocalVideoAssetStore(config.videosDir).save({ campaignId: "validation", sceneId: id, data: result.data!, metadata: { intentId: id, operationId: ref.providerJobId, model: model.model, referenceIntentId: reference.id, requestedDurationSeconds: billed } });
    const media = checkClipDuration({ requestedSeconds: billed, providerReportedSeconds: result.providerReportedDurationSeconds, actualSeconds: stored.inspection.durationSeconds, fileComplete: stored.inspection.complete });
    console.log(durationReport(media));
    const valid = media.status === "valid" && stored.inspection.hasAudioTrack;
    intent = await intents.save({ ...intent, status: valid ? "succeeded" : "failed", outputUri: stored.uri, actualCostUsd: costForUsage(pricing, usage).costUsd,
      ...(valid ? {} : { error: stored.inspection.hasAudioTrack ? `Duração inválida (${media.status}).` : "MP4 sem trilha de áudio nativo." }), updatedAt: now() });
    if (!valid) throw new Error(`Clipe salvo para auditoria (${stored.uri}) mas rejeitado: ${intent.error} Custo mantido no ledger; sem retry.`);
  });
  console.log(`Cena salva: ${intent.outputUri} · áudio nativo presente · custo ${usd(intent.actualCostUsd ?? 0)} no ledger.`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Validação não concluída."); process.exitCode = 1; });
