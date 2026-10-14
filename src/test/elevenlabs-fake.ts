import type { HttpTransport } from "@/providers/audio/elevenlabs-audio-provider";

/**
 * Transporte HTTP FALSO da ElevenLabs para testes (npm test nunca acessa a internet).
 * Gera um MP3 mínimo válido (frames MPEG-1 Layer III 128 kbps / 44,1 kHz) e um alinhamento por
 * caractere do texto recebido, com ritmo fixo. Permite simular erros HTTP, timeout e corpo inválido.
 */

export interface FakeElevenLabsOptions {
  /** Segundos por caractere no alinhamento simulado (padrão 0,06 ≈ 16 caracteres/s). */
  secondsPerChar?: number;
  status?: number;
  errorBody?: unknown;
  invalidBody?: boolean;
  /** Alinhamento com texto diferente do enviado. */
  mismatchedAlignment?: boolean;
  omitAlignment?: boolean;
  timeout?: boolean;
  networkError?: boolean;
  characterCost?: number | null;
  requestId?: string;
}

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** MP3 com N frames (cada frame 128 kbps / 44,1 kHz = 417 bytes, 1152 amostras ≈ 26,1 ms). */
export function makeMp3(frames: number): Uint8Array {
  const frameLength = Math.floor((144 * 128_000) / 44_100); // 417, sem padding
  const out = new Uint8Array(frames * frameLength);
  for (let i = 0; i < frames; i++) {
    const o = i * frameLength;
    out[o] = 0xff;
    out[o + 1] = 0xfb; // MPEG-1, Layer III, sem CRC
    out[o + 2] = 0x90; // 128 kbps, 44,1 kHz, sem padding
    out[o + 3] = 0x64;
  }
  return out;
}

export function fakeElevenLabs(options: FakeElevenLabsOptions = {}) {
  const calls: FakeCall[] = [];
  const transport: HttpTransport = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers, body });
    if (options.networkError) throw new TypeError("fetch failed");
    if (options.timeout) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

    const responseHeaders: Record<string, string> = { "content-type": "application/json", "request-id": options.requestId ?? `req_${calls.length}` };
    if (options.status && options.status >= 400) {
      return new Response(JSON.stringify(options.errorBody ?? { detail: { status: "error", message: "falhou" } }), {
        status: options.status,
        headers: responseHeaders,
      });
    }
    const text = String(body.text ?? "");
    if (options.characterCost !== null) responseHeaders["character-cost"] = String(options.characterCost ?? text.length);
    if (options.invalidBody) return new Response("{ isto não é json", { status: 200, headers: responseHeaders });

    const spc = options.secondsPerChar ?? 0.06;
    const chars = (options.mismatchedAlignment ? `${text}!` : text).split("");
    const starts = chars.map((_, i) => Math.round(i * spc * 1000) / 1000);
    const ends = chars.map((_, i) => Math.round((i + 1) * spc * 1000) / 1000);
    const seconds = chars.length * spc + 0.3;
    const audio = Buffer.from(makeMp3(Math.ceil(seconds / (1152 / 44_100)))).toString("base64");
    const payload = {
      audio_base64: audio,
      alignment: options.omitAlignment
        ? null
        : { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends },
      normalized_alignment: null,
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: responseHeaders });
  };
  return { transport, calls };
}
