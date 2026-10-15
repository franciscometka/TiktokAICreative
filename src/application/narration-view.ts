import { getSpeakerProfile } from "@/config/voices";
import type { ActualCostSummary } from "@/costs/ledger";
import type { AudioFit } from "@/domain/audio";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { roundBrl, usdToBrl } from "@/lib/money";
import { activeAttempt } from "@/pipeline/guards";

/**
 * Painel de narração (Lote 4): voz, provider, custo estimado × real, status, encaixe na duração
 * e player. Serializável; nada de voiceId, caminho de disco ou chave.
 */

export type AudioProviderId = "mock" | "elevenlabs";

export interface NarrationView {
  speaker: { id: string; name: string; description: string };
  provider: AudioProviderId;
  /** "MODO DE TESTE" (mock) ou "Narração real · ElevenLabs". */
  providerLabel: string;
  isReal: boolean;
  model: string | null;
  estimatedBrl: number | null;
  /** Custo real de TODAS as tentativas de áudio (inclui descartadas). */
  actualBrl: number | null;
  actualSimulated: boolean;
  status: "pending" | "generating" | "ready" | "review" | "failed";
  statusLabel: string;
  attempts: number;
  version: string | null;
  /** /api/audio/<campanha>/<criativo>/<versão> — só para áudio real salvo. */
  audioUrl: string | null;
  captionTiming: "alignment" | "estimated" | null;
  /** Caracteres enviados (base do custo). */
  inputCharacters: number | null;
  /** Consumo bruto informado pela ElevenLabs (créditos/quota; outra unidade). */
  providerCharacterCost: number | null;
  fit: AudioFit | null;
  note: string | null;
  lastError: string | null;
  canAccept: boolean;
  canRegenerate: boolean;
  regenerateEstimateBrl: number | null;
}

const STATUS_LABELS: Record<NarrationView["status"], string> = {
  pending: "Aguardando aprovação",
  generating: "Gerando",
  ready: "Gerada",
  review: "Revisar duração",
  failed: "Falhou",
};

export function narrationAudioUrl(campaignId: string, creativeId: string, version: string): string {
  return `/api/audio/${encodeURIComponent(campaignId)}/${encodeURIComponent(creativeId)}/${encodeURIComponent(version)}`;
}

export function buildNarrationView(input: {
  campaign: Campaign;
  job: GenerationJob | undefined;
  jobActual: ActualCostSummary | undefined;
  active: boolean;
  configuredProvider: AudioProviderId;
}): NarrationView {
  const { campaign, job, jobActual } = input;
  const speaker = getSpeakerProfile(campaign.request.speakerProfileId);
  const attempts = job?.audioAttempts ?? [];
  const current = job ? activeAttempt(attempts) : undefined;
  const last = attempts[attempts.length - 1];
  const provider: AudioProviderId = ((current ?? last)?.provider === "elevenlabs" ? "elevenlabs" : (current ?? last) ? "mock" : input.configuredProvider);
  const isReal = provider === "elevenlabs";

  const line = job?.estimate?.breakdown.find((l) => l.category === "audio");
  const estimatedBrl = line && job?.estimate ? roundBrl(usdToBrl(line.subtotalUsd, job.estimate.exchangeRate)) : null;
  const audioEntries = jobActual ? jobActual.byCategoryBrl.audio : 0;

  let status: NarrationView["status"] = "pending";
  if (job?.status === "audio_review") status = "review";
  else if (current) status = "ready";
  else if (job?.status === "generating" && input.active) status = "generating";
  else if (last?.status === "failed") status = "failed";

  const info = current?.narration;
  const canRegenerate =
    job !== undefined && job.approval !== undefined && !input.active &&
    !job.scenes.some(s => activeAttempt(s.attempts)?.presenter) && (job.status === "completed" || job.status === "audio_review");

  return {
    speaker: { id: speaker.id, name: speaker.name, description: speaker.description },
    provider,
    providerLabel: isReal ? "Narração real · ElevenLabs" : "MODO DE TESTE",
    isReal,
    model: (current ?? last)?.model ?? line?.model ?? null,
    estimatedBrl,
    actualBrl: attempts.length > 0 ? roundBrl(audioEntries) : null,
    actualSimulated: attempts.length > 0 && attempts.every((a) => a.isMock),
    status,
    statusLabel: STATUS_LABELS[status],
    attempts: attempts.length,
    version: info?.version ?? null,
    audioUrl: info?.version && job && !current?.isMock ? narrationAudioUrl(campaign.id, job.creativeId, info.version) : null,
    captionTiming: info?.captionTiming ?? null,
    inputCharacters: info?.inputCharacters ?? null,
    providerCharacterCost: info?.providerCharacterCost ?? null,
    fit: info?.fit ?? null,
    note: info?.note ?? null,
    lastError: last?.status === "failed" ? (last.error ?? "Falha na geração da narração") : null,
    canAccept: job?.status === "audio_review" && !input.active,
    canRegenerate,
    regenerateEstimateBrl: estimatedBrl,
  };
}
