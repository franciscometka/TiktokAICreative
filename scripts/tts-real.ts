import { assertRealCallsEnabled } from "../src/config/execution-policy";
/**
 * VALIDAÇÃO MANUAL com a ElevenLabs REAL — no máximo UMA chamada curta (~150 caracteres).
 *
 *   npm run tts:real                      # mostra voz, modelo, caracteres e custo estimado; NÃO chama nada
 *   npm run tts:real -- --confirm         # faz UMA chamada real (exige ELEVENLABS_API_KEY)
 *   [--quality economy|high|premium] [--voice clara|bia|rafael|lucas]
 *
 * Grava em data/manual/tts/<data>/: narration.mp3, timing.json, metadata.json e result.json
 * (request id, caracteres cobrados, custo real, duração, legendas). Nenhum vídeo é gerado e nada
 * entra no ledger das campanhas. Nenhum retry: se falhar, rode de novo só se quiser.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig, readElevenLabsApiKey } from "../src/config/env";
import { PRICING_TABLE } from "../src/config/pricing";
import { QUALITY_PRESETS, type PresetQuality } from "../src/config/quality-presets";
import { ELEVENLABS_VOICES, getSpeakerProfile } from "../src/config/voices";
import { costForUsage } from "../src/costs/calculate";
import { StaticPricingCatalog } from "../src/costs/pricing-catalog";
import { formatBrl } from "../src/lib/money";
import { ElevenLabsAudioProvider } from "../src/providers/audio/elevenlabs-audio-provider";
import { narrationTiming } from "../src/speech/alignment";
import { evaluateAudioFit } from "../src/speech/audio-fit";
import { buildScript } from "../src/speech/narration-script";
import { captionsFromWords } from "../src/speech/timed-captions";
import { LocalAudioAssetStore } from "../src/storage/audio-asset-store";

/** Texto curto e realista, com preço e número (testa a normalização pt-BR). */
const SAMPLE = [
  { sceneId: "s1", text: "Sua água esquenta antes do almoço?" },
  { sceneId: "s2", text: "Essa garrafa de inox mantém a bebida gelada por até 12 horas." },
  { sceneId: "s3", text: "Por R$ 79,90. Toca no carrinho laranja!" },
];
const TARGET_SECONDS = 9;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--confirm")) assertRealCallsEnabled();
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const quality = (arg("quality") ?? "economy") as PresetQuality;
  if (!(quality in QUALITY_PRESETS)) throw new Error(`Qualidade inválida: ${quality}`);
  const speaker = getSpeakerProfile(arg("voice"));
  const config = loadAppConfig();
  const pricing = new StaticPricingCatalog(PRICING_TABLE).requireOne(QUALITY_PRESETS[quality].audio);
  const script = buildScript(SAMPLE);
  const estimate = costForUsage(pricing, { characters: script.spoken.length });

  console.log(`Voz: ${speaker.name} (${speaker.description}) → ElevenLabs "${ELEVENLABS_VOICES[speaker.id]?.providerName}"`);
  console.log(`Modelo: ${pricing.model} · preset ${quality} · US$${pricing.priceUsd}/1000 caracteres (${pricing.updatedAt})`);
  console.log(`Texto falado (${script.spoken.length} caracteres): ${script.spoken}`);
  console.log(`Custo estimado: US$${estimate.costUsd.toFixed(5)} ≈ ${formatBrl(estimate.costUsd * config.exchangeRate.rate)}`);
  if (!process.argv.includes("--confirm")) {
    console.log("\nNada foi chamado. Para UMA chamada real, rode novamente com --confirm.");
    return;
  }
  const apiKey = readElevenLabsApiKey();
  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY não está definida. Defina no ambiente ou em .env.local e rode de novo.");
    process.exit(2);
  }

  const provider = new ElevenLabsAudioProvider({ pricing, apiKey, voices: ELEVENLABS_VOICES, timeoutMs: config.ttsTimeoutMs });
  const started = Date.now();
  const ref = await provider.generateAudio({ trackId: "narration", text: script.spoken, language: speaker.language, speakerProfileId: speaker.id });
  const result = await provider.downloadResult(ref);
  const elapsedMs = Date.now() - started;
  if (!result.data) throw new Error("Resposta sem áudio");

  const timing = result.characterTiming ? narrationTiming(script, result.characterTiming) : undefined;
  const fit = evaluateAudioFit({ targetSeconds: TARGET_SECONDS, speechSeconds: timing?.speechEndSeconds ?? result.durationSeconds, measured: true });
  const real = costForUsage(pricing, result.billedUsage);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const store = new LocalAudioAssetStore(join("data", "manual", "tts"));
  const stored = await store.save({
    campaignId: "manual",
    creativeId: `tts_${stamp}`,
    data: result.data,
    timing,
    metadata: { provider: "elevenlabs", model: pricing.model, speakerProfileId: speaker.id, voiceId: result.voiceId, requestId: result.requestId, spokenText: script.spoken },
  });
  const summary = {
    requestId: result.requestId,
    model: pricing.model,
    speakerProfileId: speaker.id,
    inputCharacters: script.spoken.length,
    providerCharacterCost: result.providerCharacterCost,
    costUsd: real.costUsd,
    costBrl: real.costUsd * config.exchangeRate.rate,
    durationSeconds: result.durationSeconds,
    speechEndSeconds: timing?.speechEndSeconds,
    elapsedMs,
    fit,
    captions: timing ? captionsFromWords(timing.words) : [],
    audio: stored.uri,
  };
  await writeFile(join("data", "manual", "tts", "manual", `tts_${stamp}`, stored.version, "result.json"), JSON.stringify(summary, null, 2));
  console.log(
    `\nOK · request ${summary.requestId ?? "—"} · ${summary.inputCharacters} caracteres enviados · US${real.costUsd.toFixed(5)} ≈ ${formatBrl(summary.costBrl)} (tabela da API)`,
  );
  console.log(`character-cost (créditos/quota da ElevenLabs, outra unidade): ${summary.providerCharacterCost ?? "—"}`);
  console.log(`Duração ${result.durationSeconds}s · fala até ${summary.speechEndSeconds ?? "—"}s · ${elapsedMs} ms · encaixe: ${fit.status}`);
  for (const c of summary.captions) console.log(`  [${c.startSeconds.toFixed(2)}–${c.endSeconds.toFixed(2)}] ${c.text}`);
  console.log(`Arquivos: ${stored.uri}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
