import { describe, expect, it } from "vitest";
import { SpeakerProfileSchema } from "@/domain/audio";
import { loadAppConfig, readElevenLabsApiKey } from "./env";
import { PRICING_TABLE } from "./pricing";
import { QUALITY_PRESETS } from "./quality-presets";
import { ELEVENLABS_MODEL_CAPABILITIES, ELEVENLABS_MODELS, NARRATION_TTS } from "./tts-models";
import {
  DEFAULT_SPEAKER_PROFILE_ID,
  ELEVENLABS_VOICES,
  getSpeakerProfile,
  SPEAKER_PROFILES,
  UnknownSpeakerProfileError,
} from "./voices";

describe("modelos de TTS por preset", () => {
  it("economy → Flash v2.5; high/premium → Multilingual v2", () => {
    expect(NARRATION_TTS.economy.model).toBe("eleven_flash_v2_5");
    expect(NARRATION_TTS.high.model).toBe("eleven_multilingual_v2");
    expect(NARRATION_TTS.premium.model).toBe("eleven_multilingual_v2");
    for (const preset of Object.values(QUALITY_PRESETS)) expect(preset.audio).toEqual(NARRATION_TTS[preset.quality as keyof typeof NARRATION_TTS]);
  });

  it("todo modelo usado tem preço OFICIAL (não provisório) e capacidades declaradas", () => {
    for (const model of Object.values(ELEVENLABS_MODELS)) {
      const price = PRICING_TABLE.find((p) => p.provider === "elevenlabs" && p.model === model);
      expect(price).toMatchObject({ unit: "per_1000_characters", isPlaceholder: false });
      expect(ELEVENLABS_MODEL_CAPABILITIES[model]).toBeDefined();
    }
    expect(PRICING_TABLE.some((p) => p.provider === "unassigned-audio")).toBe(false);
  });
});

describe("SpeakerProfile", () => {
  it("perfis pt-BR com nomes amigáveis, todos com voz ElevenLabs mapeada", () => {
    expect(SPEAKER_PROFILES.length).toBeGreaterThanOrEqual(3);
    for (const p of SPEAKER_PROFILES) {
      expect(SpeakerProfileSchema.safeParse(p).success).toBe(true);
      expect(p.language).toBe("pt-BR");
      expect(ELEVENLABS_VOICES[p.id]?.voiceId).toMatch(/^[A-Za-z0-9]{20}$/);
    }
    expect(new Set(SPEAKER_PROFILES.map((p) => p.id)).size).toBe(SPEAKER_PROFILES.length);
  });

  it("o perfil não carrega voiceId (independente do provider; pronto para PresenterProfile + SpeakerProfile)", () => {
    for (const p of SPEAKER_PROFILES) expect(JSON.stringify(p)).not.toContain(ELEVENLABS_VOICES[p.id]!.voiceId);
  });

  it("padrão quando ausente; desconhecido é recusado", () => {
    expect(getSpeakerProfile(undefined).id).toBe(DEFAULT_SPEAKER_PROFILE_ID);
    expect(() => getSpeakerProfile("robo")).toThrow(UnknownSpeakerProfileError);
  });
});

describe("config de áudio", () => {
  it("AUDIO_PROVIDER mock|elevenlabs; pasta e timeout configuráveis", () => {
    expect(loadAppConfig({}).audioProvider).toBe("mock");
    expect(loadAppConfig({ AUDIO_PROVIDER: "elevenlabs" }).audioProvider).toBe("elevenlabs");
    expect(() => loadAppConfig({ AUDIO_PROVIDER: "polly" })).toThrow();
    const c = loadAppConfig({ AUDIO_DIR: "x/audio", TTS_TIMEOUT_MS: "30000" });
    expect(c.audioDir).toBe("x/audio");
    expect(c.ttsTimeoutMs).toBe(30_000);
  });

  it("a chave da ElevenLabs só é lida do ambiente e nunca entra no AppConfig", () => {
    const env = { ELEVENLABS_API_KEY: " sk_segredo_123456 ", AUDIO_PROVIDER: "elevenlabs" };
    expect(readElevenLabsApiKey(env)).toBe("sk_segredo_123456");
    expect(readElevenLabsApiKey({})).toBeUndefined();
    expect(JSON.stringify(loadAppConfig(env))).not.toContain("sk_segredo");
  });
});
