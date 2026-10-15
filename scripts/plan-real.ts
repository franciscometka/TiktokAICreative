import { assertRealCallsEnabled } from "../src/config/execution-policy";
/**
 * VALIDAÇÃO MANUAL com o Claude REAL — faz no máximo UM planejamento (pode ter até
 * LLM_MAX_VALIDATION_ATTEMPTS chamadas se a primeira resposta for inválida).
 *
 *   npm run plan:real -- --confirm [--quality economy|high|premium] [--creatives 1]
 *
 * Requer ANTHROPIC_API_KEY no ambiente (ou em .env.local). Grava em data/manual/.
 * Nenhuma mídia é gerada: só planejamento + estimativa.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig, readAnthropicApiKey } from "../src/config/env";
import { PRICING_TABLE } from "../src/config/pricing";
import { QUALITY_PRESETS, type PresetQuality } from "../src/config/quality-presets";
import { resolveLlmPricing, worstCaseLlmCostUsd } from "../src/costs/calculate";
import { StaticPricingCatalog } from "../src/costs/pricing-catalog";
import { formatBrl } from "../src/lib/money";
import { createPipelineService } from "../src/pipeline/create-pipeline-service";
import { LlmCreativePlanner } from "../src/ai/llm-planner";
import { createAnthropicLlmClient } from "../src/ai/create-llm-client";
import { randomId } from "../src/lib/ids";
import { FilePipelineStore } from "../src/storage/file-pipeline-store";
import { FileCostLedger } from "../src/storage/file-cost-ledger";
import { FileLlmCallLog } from "../src/storage/llm-call-log";

const TEST_PRODUCT = {
  id: "manual_garrafa",
  name: "Garrafa Térmica Inox 750ml",
  description:
    "Garrafa térmica de aço inox com parede dupla a vácuo. Mantém bebidas geladas por até 24 horas e quentes por até 12 horas. Tampa rosqueável com vedação de silicone.",
  features: ["Aço inox 304", "Parede dupla a vácuo", "750ml", "Tampa com vedação de silicone", "Não transpira por fora"],
  benefits: ["Água gelada o dia todo", "Não vaza na mochila", "Substitui garrafas descartáveis"],
  priceBrl: 79.9,
  targetAudience: "Estudantes e pessoas que trabalham fora e levam água para o dia",
  images: [
    { id: "img_1", uri: "outputs/uploads/garrafa-frente.jpg" },
    { id: "img_2", uri: "outputs/uploads/garrafa-tampa.jpg" },
  ],
  notes: "Disponível nas cores preta, branca e verde.",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--confirm")) assertRealCallsEnabled();
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");

  const quality = (arg("quality") ?? "economy") as PresetQuality;
  if (!(quality in QUALITY_PRESETS)) throw new Error(`Qualidade inválida: ${quality}`);
  const creativeCount = Number(arg("creatives") ?? "1");

  const config = { ...loadAppConfig(), llmProvider: "anthropic" as const, storage: "file" as const, dataDir: join("data", "manual") };
  const settings = QUALITY_PRESETS[quality];
  const llmPricing = resolveLlmPricing(settings.llm, new StaticPricingCatalog(PRICING_TABLE));

  if (!readAnthropicApiKey()) {
    console.error("ANTHROPIC_API_KEY não está definida. Defina no ambiente ou em .env.local e rode de novo.");
    process.exit(2);
  }

  const planner = new LlmCreativePlanner(createAnthropicLlmClient(config), randomId, {
    maxValidationAttempts: config.llmPolicy.maxValidationAttempts,
  });
  const request = { product: TEST_PRODUCT, styles: ["ugc", "problem_solution"] as const, creativeCount, settings };
  const worst = worstCaseLlmCostUsd(llmPricing, planner.worstCase({ ...request, styles: [...request.styles] }));

  console.log(`Modelo: ${settings.llm.model} (esforço ${settings.llm.effort}) · preset ${quality} · ${creativeCount} criativo(s)`);
  console.log(`Pior caso desta validação: US$${worst.toFixed(4)} ≈ ${formatBrl(worst * config.exchangeRate.rate)}`);
  if (!process.argv.includes("--confirm")) {
    console.log("\nNada foi chamado. Para executar UMA validação real, rode novamente com --confirm.");
    return;
  }

  const storage = {
    store: new FilePipelineStore(config.dataDir),
    ledger: new FileCostLedger(config.dataDir),
    llmCallLog: new FileLlmCallLog(config.dataDir),
  };
  const service = createPipelineService(config, { planner, ...storage });
  const campaign = await service.planCampaign({
    product: TEST_PRODUCT,
    styles: ["ugc", "problem_solution"],
    creativeCount,
    quality,
    budget: config.defaultBudget,
  });

  const calls = await storage.llmCallLog.list({ campaignId: campaign.id });
  console.log("\n== Chamadas ao Claude ==");
  for (const c of calls) {
    console.log(
      `#${c.attempt} ${c.outcome} · ${c.servedModel} · req ${c.requestId ?? "-"} · in ${c.usage.inputTokens} / out ${c.usage.outputTokens} / cache w ${c.usage.cacheCreationInputTokens} r ${c.usage.cacheReadInputTokens} · ${(c.durationMs / 1000).toFixed(1)}s · US$${c.costUsd.toFixed(4)} (${formatBrl(c.costBrl)})${c.errorSummary ? `\n   ${c.errorSummary.slice(0, 300)}` : ""}`,
    );
  }

  if (campaign.status !== "planned" || !campaign.plan) {
    console.error(`\nPlanejamento falhou: ${campaign.error}`);
    process.exitCode = 1;
    return;
  }

  const plan = campaign.plan;
  console.log(`\n== Análise ==\n${plan.analysis.summary}`);
  console.log(`Riscos de comunicação: ${plan.analysis.communicationRisks.join(" | ") || "-"}`);
  console.log(`Informações ausentes: ${plan.analysis.missingInformation.join(" | ") || "-"}`);
  console.log(`\n== Hooks (${plan.hooks.length}) ==`);
  for (const h of plan.hooks) console.log(`- [${h.style}] ${h.text}`);

  for (const [i, creative] of plan.creatives.entries()) {
    const review = campaign.reviews?.[i];
    const job = await storage.store.getJob(campaign.jobIds[i]!);
    const e = job.estimate!;
    console.log(`\n== Criativo ${i + 1}: ${creative.concept.title} [${creative.concept.format}] ==`);
    console.log(`Hook: ${creative.hook}\nCTA: ${creative.callToAction}`);
    console.log(
      `Duração ${creative.duration}s · vídeo IA ${review?.final.generatedSeconds}s (permitido ${settings.generatedVideoSeconds.min}–${settings.generatedVideoSeconds.max}s; original ${review?.original.generatedSeconds}s)`,
    );
    for (const a of review?.adjustments ?? []) console.log(`  ajuste: ${a.message}`);
    for (const w of review?.final.warnings ?? []) console.log(`  aviso: ${w.message}`);
    for (const s of creative.scenes) {
      console.log(
        `  ${s.order + 1}. ${s.duration}s ${s.visualSource}${s.requiresGeneratedVideo ? ` (IA ${s.estimatedGenerationSeconds}s)` : ` / ${s.motion}`} — "${s.onScreenText}" — ${s.narration}`,
      );
    }
    console.log(`  CUSTO JÁ INCORRIDO (Claude, rateado): ${formatBrl(e.incurred.llmCost.brl)}`);
    console.log(
      `  FUTURO ESTIMADO: vídeo ${formatBrl(e.videoCost.brl)} + áudio ${formatBrl(e.audioCost.brl)} + render ${formatBrl(e.renderingCost.brl)} = ${formatBrl(e.estimatedAdditionalBrl)}`,
    );
    console.log(`  TOTAL PROJETADO: ${formatBrl(e.projectedTotalBrl)}${e.containsPlaceholderPrices ? " (preços de mídia provisórios)" : ""}`);
  }

  const out = join(config.dataDir, `plan-${campaign.id}.json`);
  await writeFile(out, JSON.stringify({ campaign, calls }, null, 2));
  console.log(`\nPlano completo salvo em ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
