/** Validação manual: sem --confirm só lê a imagem e mostra custo. Com --confirm: UM POST pago via pipeline. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MockCreativePlanner } from "../src/ai/mock-planner";
import { loadAppConfig, readRunwayApiKey } from "../src/config/env";
import { RUNWAY_VIDEO } from "../src/config/video-models";
import { RUNWAY_CREDITS_PER_SECOND, RUNWAY_CREDIT_USD } from "../src/config/pricing";
import { detectImageType } from "../src/domain/upload";
import { randomId } from "../src/lib/ids";
import { createPipelineService } from "../src/pipeline/create-pipeline-service";
import { imageDimensions } from "../src/render/image-dimensions";
import { LocalUploadStore } from "../src/storage/upload-store";

async function main() {
  const { values } = parseArgs({ options: { image: { type: "string" }, confirm: { type: "boolean", default: false } }, strict: true });
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!values.image) throw new Error('Informe --image com o caminho de uma foto JPG/PNG/WebP.');
  const bytes = await readFile(values.image);
  const contentType = detectImageType(bytes);
  if (!contentType || !imageDimensions(bytes, contentType)) throw new Error("A foto não é uma imagem válida.");
  if (Buffer.byteLength(`data:${contentType};base64,${bytes.toString("base64")}`) > 5 * 1024 * 1024) throw new Error("Reduza a foto: limite de 5 MB codificada.");
  const seconds = 5;
  const credits = seconds * RUNWAY_CREDITS_PER_SECOND;
  const config = loadAppConfig();
  console.log(`Runway Gen-4 Turbo · ${seconds}s · 720:1280 · ${credits} créditos · estimativa US$${(credits * RUNWAY_CREDIT_USD).toFixed(2)} (≈ R$${(credits * RUNWAY_CREDIT_USD * config.exchangeRate.rate).toFixed(2)})`);
  console.log("Uma cena; planejamento, áudio e renderer mock. Nenhuma chamada a Claude ou ElevenLabs.");
  if (!values.confirm) { console.log("Dry-run: nenhuma chamada, nenhum arquivo gravado. Use --confirm somente para autorizar UMA geração paga."); return; }
  if (!readRunwayApiKey()) throw new Error("RUNWAYML_API_SECRET não configurada.");
  const productId = randomId("prod");
  const image = await new LocalUploadStore(config.uploadsDir).save(productId, { bytes, size: bytes.length, declaredType: contentType });
  const mock = new MockCreativePlanner(randomId);
  const service = createPipelineService({ ...config, llmProvider: "mock", videoProvider: "runway", audioProvider: "mock", storage: "file", renderer: { ...config.renderer, id: "mock" } }, {
    planner: {
      id: "mock", worstCase: (request) => mock.worstCase(request),
      plan: async (request) => {
        const result = await mock.plan(request);
        for (const creative of result.plan.creatives) {
          creative.scenes = creative.scenes.map((scene, index) => ({ ...scene,
            requiresGeneratedVideo: index === 0, estimatedGenerationSeconds: index === 0 ? Math.min(scene.duration, seconds) : 0,
            visualSource: index === 0 ? "generated_video" : "product_image",
            generationPrompt: index === 0 ? "Slow camera push in on the product. Preserve its shape, color and label. Natural studio lighting. No text or new objects." : "",
          }));
        }
        return result;
      },
    },
  });
  const campaign = await service.planCampaign({ product: { id: productId, name: "Validação manual Runway", description: "Produto da foto de referência; sem alegações adicionais.", features: [], benefits: [], images: [{ id: image.id, uri: image.uri }] }, styles: ["demonstration"], creativeCount: 1, quality: "economy", budget: config.defaultBudget });
  const jobId = campaign.jobIds[0]!;
  const estimated = await service.estimateCost(jobId);
  console.log(`Campanha ${campaign.id} · job ${jobId} · modelo ${RUNWAY_VIDEO.model}`);
  await service.requestApproval(jobId);
  const approval = await service.approve(jobId, { estimateId: estimated.estimate!.id });
  if (approval.kind !== "APPROVED") throw new Error("Orçamento excedido: nenhuma chamada paga. Revise o limite antes de uma nova validação.");
  const outcome = await service.generate(jobId);
  if (outcome.kind !== "COMPLETED") throw new Error(`Validação terminou em ${outcome.kind}: ${outcome.job.error ?? "consulte o job persistido"}. Não houve retry automático.`);
  console.log("Clipe salvo e custo registrado no ledger. Consulte a campanha; o renderer mock não cria MP4 final.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Validação não concluída."); process.exitCode = 1; });
