import { randomUUID } from "node:crypto";
import { assertRealCallsEnabled } from "@/config/execution-policy";
import { z } from "zod";
import {
  ELEVENLABS_LANGUAGE_CODES,
  ELEVENLABS_MODEL_CAPABILITIES,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_PROVIDER,
  MAX_NARRATION_CHARACTERS,
  type ElevenLabsModelId,
} from "@/config/tts-models";
import type { ElevenLabsVoice } from "@/config/voices";
import { costForUsage, type Usage } from "@/costs/calculate";
import type { CharacterTiming } from "@/domain/audio";
import type { ProviderPricing } from "@/domain/cost";
import {
  ProviderError,
  type CostQuote,
  type ProviderDescriptor,
  type ProviderJobRef,
  type ProviderJobStatus,
} from "../types";
import type { AudioGenerationRequest, AudioProvider, AudioResult } from "./audio-provider";
import { mp3DurationSeconds } from "./mp3";

/**
 * TTS real com a ElevenLabs (`POST /v1/text-to-speech/{voice_id}/with-timestamps`).
 * TODA a integração com a ElevenLabs fica neste arquivo: formato da requisição, da resposta,
 * erros e headers. Para fora sai só `AudioResult` (tipos internos).
 *
 * Regras de custo:
 * - UMA requisição por narração; nenhum retry automático (nem de transporte).
 * - Falha HTTP (4xx/5xx) não é cobrada pela ElevenLabs → sem billedUsage.
 * - Resposta 200 inválida → falha COM billedUsage (a geração provavelmente foi cobrada).
 * - Custo = caracteres enviados × preço; `character-cost` (créditos) só vai para auditoria.
 * - Timeout → falha sem billedUsage, mas a mensagem avisa da possível cobrança não confirmada.
 * A API key fica em campo privado e nunca entra em mensagens, logs ou resultados.
 */

export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsAudioProviderOptions {
  pricing: ProviderPricing;
  apiKey: string;
  voices: Readonly<Record<string, ElevenLabsVoice>>;
  timeoutMs: number;
  transport?: HttpTransport;
  baseUrl?: string;
}

const ResponseSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: z
    .object({
      characters: z.array(z.string()),
      character_start_times_seconds: z.array(z.number()),
      character_end_times_seconds: z.array(z.number()),
    })
    .nullable()
    .optional(),
});

export class ElevenLabsAudioProvider implements AudioProvider {
  readonly descriptor: ProviderDescriptor;
  readonly #apiKey: string;
  private readonly transport: HttpTransport;
  private readonly baseUrl: string;
  private readonly results = new Map<string, AudioResult>();

  constructor(private readonly options: ElevenLabsAudioProviderOptions) {
    if (!options.apiKey.trim()) throw new ProviderError("ELEVENLABS_API_KEY não está definida");
    if (!(options.pricing.model in ELEVENLABS_MODEL_CAPABILITIES)) {
      throw new ProviderError(`Modelo ElevenLabs não configurado: ${options.pricing.model}`);
    }
    this.#apiKey = options.apiKey.trim();
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
    this.descriptor = { id: ELEVENLABS_PROVIDER, model: options.pricing.model, isMock: false, pricing: options.pricing };
  }

  estimateCost(request: AudioGenerationRequest): CostQuote {
    const { quantity, costUsd } = costForUsage(this.options.pricing, this.usageFor(request.text.length));
    return { kind: "estimate", quantity, costUsd, pricing: this.options.pricing };
  }

  async generateAudio(request: AudioGenerationRequest): Promise<ProviderJobRef> {
    if (!this.options.transport) assertRealCallsEnabled();
    const text = request.text.trim();
    // Validações locais ANTES de qualquer chamada (nada é cobrado).
    if (!text) throw new ProviderError("Narração vazia");
    const capabilities = ELEVENLABS_MODEL_CAPABILITIES[this.descriptor.model as ElevenLabsModelId];
    if (text.length > Math.min(MAX_NARRATION_CHARACTERS, capabilities.maxCharacters)) {
      throw new ProviderError(`Narração com ${text.length} caracteres passa do limite de ${MAX_NARRATION_CHARACTERS}`);
    }
    const voice = this.options.voices[request.speakerProfileId];
    if (!voice) throw new ProviderError(`Perfil de voz sem voz ElevenLabs configurada: ${request.speakerProfileId}`);

    const body: Record<string, unknown> = {
      text,
      model_id: this.descriptor.model,
      voice_settings: {
        stability: voice.settings.stability,
        similarity_boost: voice.settings.similarityBoost,
        style: voice.settings.style,
        use_speaker_boost: true,
        speed: voice.settings.speed,
      },
      apply_text_normalization: "auto",
    };
    if (capabilities.acceptsLanguageCode) body.language_code = ELEVENLABS_LANGUAGE_CODES[request.language];

    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: { "xi-api-key": this.#apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError(
          `Tempo esgotado na ElevenLabs (${Math.round(this.options.timeoutMs / 1000)}s). A chamada pode ter sido cobrada sem confirmação; nada foi re-tentado.`,
        );
      }
      throw new ProviderError("Falha de conexão com a ElevenLabs (nada foi re-tentado)");
    }

    const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) throw new ProviderError(await this.httpErrorMessage(response), requestId);

    // Custo monetário = caracteres ENVIADOS × preço da API. O header `character-cost` é consumo de
    // créditos/quota da assinatura (outra unidade; ex.: 85 para 169 caracteres no Flash) — guardado
    // à parte, nunca multiplicado pelo preço (seria desconto duplicado).
    const providerCharacterCost = parseCharacterCost(response.headers.get("character-cost"));
    const billedUsage = this.usageFor(text.length);
    let parsed: z.infer<typeof ResponseSchema>;
    let data: Uint8Array;
    try {
      parsed = ResponseSchema.parse(JSON.parse(await response.text()));
      data = new Uint8Array(Buffer.from(parsed.audio_base64, "base64"));
      if (data.length === 0) throw new Error("áudio vazio");
    } catch {
      throw new ProviderError("Resposta inválida da ElevenLabs (áudio ausente ou corrompido)", requestId, billedUsage);
    }

    const characterTiming = toCharacterTiming(parsed.alignment);
    const speechEnd = characterTiming ? Math.max(0, ...characterTiming.endSeconds) : undefined;
    const durationSeconds = mp3DurationSeconds(data) ?? speechEnd ?? text.length / 15;
    const providerJobId = requestId ?? `elevenlabs_${randomUUID()}`;
    this.results.set(providerJobId, {
      uri: `elevenlabs://${providerJobId}`,
      mimeType: "audio/mpeg",
      durationSeconds,
      billedUsage: { ...billedUsage, seconds: durationSeconds },
      isMock: false,
      data,
      extension: "mp3",
      characterTiming,
      requestId,
      voiceId: voice.voiceId,
      inputCharacters: text.length,
      providerCharacterCost,
    });
    return { providerJobId };
  }

  async getStatus(ref: ProviderJobRef): Promise<ProviderJobStatus> {
    // A API com timestamps é síncrona: se existe resultado, a geração terminou.
    if (!this.results.has(ref.providerJobId)) throw new ProviderError("Job desconhecido", ref.providerJobId);
    return { providerJobId: ref.providerJobId, state: "succeeded" };
  }

  async downloadResult(ref: ProviderJobRef): Promise<AudioResult> {
    const result = this.results.get(ref.providerJobId);
    if (!result) throw new ProviderError("Resultado indisponível", ref.providerJobId);
    this.results.delete(ref.providerJobId); // entregue uma vez; bytes não ficam na memória
    return result;
  }

  private usageFor(characters: number): Usage {
    return { characters, generations: 1 };
  }

  private async httpErrorMessage(response: Response): Promise<string> {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      const d = body.detail;
      if (typeof d === "string") detail = d;
      else if (Array.isArray(d)) detail = d.map((x: { msg?: string }) => x.msg ?? "").filter(Boolean).join("; ");
      else if (d && typeof d === "object") {
        const o = d as { status?: string; message?: string };
        detail = [o.status, o.message].filter(Boolean).join(": ");
      }
    } catch {
      // corpo não-JSON: ignorado
    }
    detail = this.redact(detail).slice(0, 200);
    const suffix = detail ? ` — ${detail}` : "";
    switch (true) {
      case response.status === 401 || response.status === 403:
        return `ElevenLabs recusou a autenticação (${response.status}). Confira ELEVENLABS_API_KEY${suffix}`;
      case response.status === 400 || response.status === 422:
        return `ElevenLabs recusou a requisição (${response.status})${suffix}`;
      case response.status === 429:
        return `ElevenLabs: limite de uso ou de cota atingido (429)${suffix}`;
      default:
        return `Erro da ElevenLabs (${response.status})${suffix}`;
    }
  }

  private redact(text: string): string {
    return text.split(this.#apiKey).join("[redigido]").replace(/sk_[A-Za-z0-9]{8,}/g, "[redigido]");
  }
}

function parseCharacterCost(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Formato da ElevenLabs → CharacterTiming interno. Tamanhos inconsistentes = sem timing. */
function toCharacterTiming(alignment: z.infer<typeof ResponseSchema>["alignment"]): CharacterTiming | undefined {
  if (!alignment) return undefined;
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (characters.length === 0 || characters.length !== starts.length || characters.length !== ends.length) return undefined;
  return { characters, startSeconds: starts.map((s) => Math.max(0, s)), endSeconds: ends.map((e) => Math.max(0, e)) };
}
