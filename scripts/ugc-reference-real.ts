/**
 * Teste A (Lote 5.4): UMA referência AI UGC real (Gemini image). Sem --confirm: nenhuma rede,
 * nenhuma gravação. Com --confirm: exige readiness Google completo e faz EXATAMENTE um POST.
 * `--approve <id>` marca a referência como aprovada visualmente (local, sem rede) para o Teste B.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { buildUgcReferencePrompt } from "../src/ai/ugc-script";
import { loadAppConfig } from "../src/config/env";
import { withRealStageAuthorization } from "../src/config/execution-policy";
import { PRICING_TABLE } from "../src/config/pricing";
import { productAnchor, resolveUgcIdentity } from "../src/config/ugc";
import { googleUgcReadiness } from "../src/config/ugc-readiness";
import { kreaUgcReadiness } from "../src/config/krea-ugc-readiness";
import { KREA_MAX_UPLOAD_BYTES } from "../src/providers/ugc/krea-http";
import { kreaUgcPricingRefs } from "../src/config/krea-ugc-models";
import { buildActualCost, costForUsage } from "../src/costs/calculate";
import { StaticPricingCatalog } from "../src/costs/pricing-catalog";
import { UgcRequestSchema } from "../src/domain/ugc";
import { detectImageType } from "../src/domain/upload";
import { randomId } from "../src/lib/ids";
import { ugcInputHash } from "../src/pipeline/ugc-flow";
import { DEFAULT_POLL_OPTIONS, waitForCompletion } from "../src/providers/poll";
import { ProviderError } from "../src/providers/types";
import { createUgcProviderFactories } from "../src/providers/ugc";
import { buildGoogleUgcReferenceRequest } from "../src/providers/ugc/google-ugc-contract";
import { googleUgcRuntime } from "../src/providers/ugc/google-runtime";
import { kreaUgcRuntime } from "../src/providers/ugc/krea-runtime";
import { GOOGLE_MAX_INLINE_IMAGE_BYTES } from "../src/providers/ugc/google-transports";
import { imageDimensions } from "../src/render/image-dimensions";
import { FileCostLedger } from "../src/storage/file-cost-ledger";
import { LocalUgcAssetStore, type ReferenceMime } from "../src/storage/ugc-asset-store";
import { LocalUploadStore } from "../src/storage/upload-store";
import { printReadiness, usd, ValidationIntentStore, type ValidationIntent } from "./ugc-validation";

async function main() {
  const { values } = parseArgs({
    options: {
      image: { type: "string" }, name: { type: "string", default: "Produto da foto" },
      presenter: { type: "string", default: "auto" }, environment: { type: "string", default: "auto" },
      approve: { type: "string" }, confirm: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const config = loadAppConfig();
  const intents = new ValidationIntentStore(join(config.dataDir, "ugc-validation"));

  if (values.approve) {
    const intent = await intents.get(values.approve);
    if (!intent || intent.stage !== "ugc_reference" || intent.status !== "succeeded") throw new Error("Só uma referência gerada com sucesso pode ser aprovada.");
    await intents.save({ ...intent, approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.log(`Referência ${intent.id} aprovada visualmente. Teste B: npm run ugc:video:real -- --reference ${intent.id}`);
    return;
  }

  if (!values.image) throw new Error("Informe --image com a foto ORIGINAL do produto (JPG/PNG/WebP).");
  const bytes = new Uint8Array(await readFile(values.image));
  const mimeType = detectImageType(bytes);
  const size = mimeType ? imageDimensions(bytes, mimeType) : undefined;
  if (!mimeType || !size) throw new Error("A foto não é uma imagem válida.");
  const isKrea = config.ugc.provider === "krea";
  const uploadLimit = isKrea ? KREA_MAX_UPLOAD_BYTES : GOOGLE_MAX_INLINE_IMAGE_BYTES;
  if (bytes.byteLength > uploadLimit) throw new Error(`Reduza a foto: limite de ${Math.floor(uploadLimit / 1024 / 1024)} MB.`);
  const request = UgcRequestSchema.parse({ presenter: values.presenter, environment: values.environment });
  const product = { id: "prod_validation", name: values.name!, description: "Produto da foto de referência; sem alegações adicionais.", features: [], benefits: [], images: [{ id: "img_validation", uri: "pending-upload" }] };
  const identity = resolveUgcIdentity({ id: "character_validation", revision: 1, product, request });
  const pricingRef = isKrea ? kreaUgcPricingRefs("high").reference : { provider: "google", model: config.ugc.referenceModel };
  const pricing = new StaticPricingCatalog(PRICING_TABLE).requireOne(pricingRef);
  const estimated = costForUsage(pricing, { generations: 1 }).costUsd;
  const readiness = isKrea ? kreaUgcReadiness(config) : googleUgcReadiness(config);

  console.log(`Teste A · referência AI UGC · ${pricing.model} · 9:16 · 1K · 1 imagem`);
  console.log(`Custo estimado: ${usd(estimated)} (≈ R$${(estimated * config.exchangeRate.rate).toFixed(2)}) · teto desta chamada = estimativa`);
  console.log(`Entrada: ${basename(values.image)} (${mimeType}, ${size.width}x${size.height}) · pessoa SINTÉTICA adulta, sem celebridade/pessoa real`);
  console.log(`Identidade: ${identity.gender}, ${identity.appearance}; figurino ${identity.wardrobe}; ambiente ${identity.environmentDescription}`);
  console.log("Preserva: formato, cores, logo, embalagem, proporções do produto original.");
  printReadiness(readiness, isKrea ? "Krea" : "Google");
  if (!values.confirm) { console.log("Dry-run: nenhuma chamada, nenhum arquivo gravado. Use --confirm para autorizar EXATAMENTE UMA geração paga."); return; }
  if (!readiness.ready) throw new Error(readiness.reason);
  const open = await intents.unresolved("ugc_reference");
  if (open.length) throw new Error(`Intenção ${open[0]!.id} sem desfecho (${open[0]!.status}): possível cobrança. Nenhum novo envio; confira no provider.`);

  const id = randomId("ugcref").replace(/-/g, "").slice(0, 40).toLowerCase();
  const image = await new LocalUploadStore(config.uploadsDir).save(product.id, { bytes, size: bytes.byteLength, declaredType: mimeType });
  const anchor = productAnchor({ ...product, images: [{ id: image.id, uri: image.uri }] })!;
  const prompt = buildUgcReferencePrompt(identity, anchor);
  const now = () => new Date().toISOString();
  let intent: ValidationIntent = await intents.save({
    id, stage: "ugc_reference", model: pricing.model, status: "preparing", maxCostUsd: estimated, estimatedCostUsd: estimated,
    provider: isKrea ? "krea" : "google",
    inputHash: isKrea
      ? ugcInputHash({ provider: "krea", model: pricing.model, product: anchor, identity, prompt, aspectRatio: "9:16" })
      : ugcInputHash(buildGoogleUgcReferenceRequest({ product: anchor, identity, prompt, aspectRatio: "9:16" })),
    createdAt: now(), updatedAt: now(),
    inputs: { productUri: anchor.imageUri, identity: JSON.stringify(identity), product: JSON.stringify(anchor) },
  });
  const provider = createUgcProviderFactories({ google: googleUgcRuntime(config), krea: kreaUgcRuntime(config) }).reference(pricing, "real");
  const ledger = new FileCostLedger(config.dataDir);
  const record = (usage: { generations?: number }) => ledger.record(buildActualCost({
    id: `cost_${id}`, campaignId: "validation", jobId: id, creativeId: id, sceneId: null, attemptId: id,
    operation: "ugc_reference_generation", category: "ugc_reference", description: "Validação manual: referência AI UGC",
    pricing, usage, exchangeRate: config.exchangeRate.rate, simulated: false, createdAt: now(),
  }));
  await withRealStageAuthorization("ugc_reference", async () => {
    try {
      const request = { product: anchor, identity, prompt, aspectRatio: "9:16" as const };
      const prepared = provider.prepare ? await provider.prepare(request) : undefined;
      if (isKrea && prepared) {
        const m = prepared.metadata;
        intent = await intents.save({ ...intent, asset: {
          provider: "krea", version: Number(m.kreaAssetVersion), sourceHash: String(m.kreaAssetHash), id: String(m.kreaAssetId),
          url: String(m.kreaAssetUrl), uploadedAt: String(m.kreaAssetUploadedAt), jobId: id,
        }, updatedAt: now() });
      }
      intent = await intents.save({ ...intent, status: "submitting", paidSubmissionStartedAt: now(), updatedAt: now() });
      const ref = await provider.submit(request, prepared);
      intent = await intents.save({ ...intent, status: "submitted", operationId: ref.providerJobId, ...(ref.requestId ? { requestId: ref.requestId } : {}), updatedAt: now() });
      await waitForCompletion(r => provider.getStatus(r), ref, DEFAULT_POLL_OPTIONS);
      const result = await provider.downloadResult(ref);
      await record(result.billedUsage); // ledger ANTES de gravar o arquivo
      const stored = await new LocalUgcAssetStore(config.ugcDir).saveReference({ campaignId: "validation", creativeId: id, data: result.data!, mimeType: result.mimeType as ReferenceMime,
        metadata: { intentId: id, operationId: ref.providerJobId, requestId: result.requestId ?? ref.requestId, model: pricing.model, identity, product: anchor, prompt, width: result.width, height: result.height, usage: result.metadata } });
      intent = await intents.save({ ...intent, status: "succeeded", outputUri: stored.uri, ...((result.requestId ?? ref.requestId) ? { requestId: result.requestId ?? ref.requestId } : {}),
        actualCostUsd: costForUsage(pricing, result.billedUsage).costUsd, inputs: { ...intent.inputs, referenceUri: stored.uri, referenceVersion: stored.version }, updatedAt: now() });
    } catch (error) {
      const diagnostic = error instanceof ProviderError ? error.diagnostic : undefined;
      if (error instanceof ProviderError && error.billedUsage) await record(error.billedUsage);
      const definitive = diagnostic?.billing === "rejected" || diagnostic?.operation === "none" || diagnostic?.operation === "created" || (error instanceof ProviderError && !!error.billedUsage);
      await intents.save({ ...intent, status: definitive ? "failed" : "uncertain", error: error instanceof Error ? error.message : "falha", ...(diagnostic?.requestId ? { requestId: diagnostic.requestId } : {}), updatedAt: now() });
      throw error;
    }
  });
  console.log(`Referência salva: ${intent.outputUri} · intenção ${id} · custo ${usd(intent.actualCostUsd ?? 0)} no ledger.`);
  console.log(`Revise a imagem. Se a pessoa e o produto estiverem corretos: npm run ugc:reference:real -- --approve ${id}`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Validação não concluída."); process.exitCode = 1; });
