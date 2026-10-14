import { describe, expect, it } from "vitest";
import { PRICING_TABLE } from "@/config/pricing";
import { ELEVENLABS_MODELS } from "@/config/tts-models";
import { ELEVENLABS_VOICES } from "@/config/voices";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { fakeElevenLabs, makeMp3, type FakeElevenLabsOptions } from "@/test/elevenlabs-fake";
import { ProviderError } from "../types";
import { ElevenLabsAudioProvider } from "./elevenlabs-audio-provider";
import { createAudioProviderFactory } from "./index";
import { mp3DurationSeconds } from "./mp3";

const catalog = new StaticPricingCatalog(PRICING_TABLE);
const flash = catalog.requireOne({ provider: "elevenlabs", model: ELEVENLABS_MODELS.flash });
const multilingual = catalog.requireOne({ provider: "elevenlabs", model: ELEVENLABS_MODELS.multilingual });
const KEY = "sk_test_0123456789abcdef";
const REQUEST = { trackId: "narration", text: "Essa garrafa custa setenta e nove reais.", language: "pt-BR" as const, speakerProfileId: "clara" };

function provider(fake: FakeElevenLabsOptions = {}, pricing = flash) {
  const http = fakeElevenLabs(fake);
  const p = new ElevenLabsAudioProvider({ pricing, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 5_000, transport: http.transport });
  return { p, calls: http.calls };
}

async function generate(p: ElevenLabsAudioProvider, request = REQUEST) {
  const ref = await p.generateAudio(request);
  await p.getStatus(ref);
  return { ref, result: await p.downloadResult(ref) };
}

describe("ElevenLabsAudioProvider (transporte falso)", () => {
  it("chama o endpoint com timestamps, voz do perfil, modelo do preset e pt-BR; a chave só vai no header", async () => {
    const { p, calls } = provider();
    await generate(p);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICES.clara!.voiceId}/with-timestamps?output_format=mp3_44100_128`,
    );
    expect(call.headers["xi-api-key"]).toBe(KEY);
    expect(call.body).toMatchObject({ text: REQUEST.text, model_id: "eleven_flash_v2_5", language_code: "pt" });
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it("multilingual_v2 não recebe language_code (o modelo não aceita)", async () => {
    const { p, calls } = provider({}, multilingual);
    await generate(p);
    expect(calls[0]?.body.model_id).toBe("eleven_multilingual_v2");
    expect(calls[0]?.body).not.toHaveProperty("language_code");
  });

  it("converte a resposta para tipos internos: bytes, timing por caractere, request id, caracteres cobrados", async () => {
    const { p } = provider({ requestId: "req_abc", characterCost: 38 });
    const { ref, result } = await generate(p);
    expect(ref.providerJobId).toBe("req_abc");
    expect(result).toMatchObject({ isMock: false, mimeType: "audio/mpeg", requestId: "req_abc", billedCharacters: 38, extension: "mp3" });
    expect(result.billedUsage).toMatchObject({ characters: 38, generations: 1 });
    expect(result.data?.length).toBeGreaterThan(400);
    expect(result.characterTiming?.characters.join("")).toBe(REQUEST.text);
    expect(result.characterTiming?.startSeconds[0]).toBe(0);
    expect(result.voiceId).toBe(ELEVENLABS_VOICES.clara!.voiceId);
    // Duração lida dos frames do MP3 (não estimada).
    expect(result.durationSeconds).toBeCloseTo(REQUEST.text.length * 0.06 + 0.3, 1);
  });

  it("sem header character-cost, cobra o tamanho do texto enviado", async () => {
    const { p } = provider({ characterCost: null });
    const { result } = await generate(p);
    expect(result.billedUsage.characters).toBe(REQUEST.text.length);
  });

  it("estimativa usa o preço oficial do modelo (US$0,04/1K no Flash, US$0,08/1K no Multilingual)", () => {
    expect(provider().p.estimateCost({ ...REQUEST, text: "x".repeat(1000) }).costUsd).toBeCloseTo(0.04, 10);
    expect(provider({}, multilingual).p.estimateCost({ ...REQUEST, text: "x".repeat(500) }).costUsd).toBeCloseTo(0.04, 10);
    expect(flash.isPlaceholder).toBe(false);
  });

  it("resultado é entregue uma vez (bytes não ficam na memória)", async () => {
    const { p } = provider();
    const { ref } = await generate(p);
    await expect(p.downloadResult(ref)).rejects.toBeInstanceOf(ProviderError);
  });

  it.each([
    [401, "autenticação"],
    [422, "recusou a requisição"],
    [429, "limite de uso"],
    [500, "Erro da ElevenLabs (500)"],
  ])("HTTP %i vira ProviderError legível, sem custo e sem retry", async (status, text) => {
    const { p, calls } = provider({ status, errorBody: { detail: { status: "x", message: `falhou com ${KEY}` } } });
    const error = await p.generateAudio(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain(text);
    expect((error as ProviderError).message).not.toContain(KEY); // chave redigida mesmo se o provider ecoar
    expect((error as ProviderError).billedUsage).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("detail 422 em lista (validação) aparece na mensagem", async () => {
    const { p } = provider({ status: 422, errorBody: { detail: [{ loc: ["body", "text"], msg: "texto muito longo", type: "value_error" }] } });
    await expect(p.generateAudio(REQUEST)).rejects.toThrow(/texto muito longo/);
  });

  it("corpo 200 inválido: falha COM uso cobrado (a geração provavelmente foi cobrada)", async () => {
    const { p } = provider({ invalidBody: true, characterCost: 41 });
    const error = (await p.generateAudio(REQUEST).catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.billedUsage?.characters).toBe(41);
  });

  it("timeout e erro de rede: uma única tentativa, mensagem avisa de possível cobrança", async () => {
    const t = provider({ timeout: true });
    await expect(t.p.generateAudio(REQUEST)).rejects.toThrow(/pode ter sido cobrada/);
    expect(t.calls).toHaveLength(1);
    const n = provider({ networkError: true });
    await expect(n.p.generateAudio(REQUEST)).rejects.toThrow(/conexão/);
    expect(n.calls).toHaveLength(1);
  });

  it("validações locais recusam ANTES de chamar: texto vazio, longo demais, voz desconhecida", async () => {
    const { p, calls } = provider();
    await expect(p.generateAudio({ ...REQUEST, text: "   " })).rejects.toThrow(/vazia/);
    await expect(p.generateAudio({ ...REQUEST, text: "a".repeat(2_600) })).rejects.toThrow(/limite/);
    await expect(p.generateAudio({ ...REQUEST, speakerProfileId: "nao-existe" })).rejects.toThrow(/Perfil de voz/);
    expect(calls).toHaveLength(0);
  });

  it("alinhamento ausente ou com tamanhos diferentes → sem timing (fallback de legendas)", async () => {
    const { p } = provider({ omitAlignment: true });
    expect((await generate(p)).result.characterTiming).toBeUndefined();
  });

  it("recusa construir sem chave ou com modelo não configurado", () => {
    expect(() => new ElevenLabsAudioProvider({ pricing: flash, apiKey: " ", voices: ELEVENLABS_VOICES, timeoutMs: 1000 })).toThrow(ProviderError);
    expect(
      () => new ElevenLabsAudioProvider({ pricing: { ...flash, model: "eleven_v9" }, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 1000 }),
    ).toThrow(/não configurado/);
  });
});

describe("factory de áudio", () => {
  it("mock por padrão; elevenlabs sem chave falha com erro claro", () => {
    expect(createAudioProviderFactory("mock")(flash).descriptor.isMock).toBe(true);
    expect(() => createAudioProviderFactory("elevenlabs", { ttsTimeoutMs: 1000 })(flash)).toThrow(/ELEVENLABS_API_KEY/);
    const real = createAudioProviderFactory("elevenlabs", { ttsTimeoutMs: 1000, elevenLabsApiKey: KEY })(flash);
    expect(real.descriptor).toMatchObject({ id: "elevenlabs", isMock: false, model: "eleven_flash_v2_5" });
    expect(JSON.stringify(real.descriptor)).not.toContain(KEY);
  });
});

describe("mp3DurationSeconds", () => {
  it("soma os frames (CBR 128 kbps / 44,1 kHz) e pula ID3", () => {
    expect(mp3DurationSeconds(makeMp3(100))).toBeCloseTo((100 * 1152) / 44_100, 3);
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]);
    expect(mp3DurationSeconds(new Uint8Array([...id3, ...makeMp3(10)]))).toBeCloseTo((10 * 1152) / 44_100, 3);
    expect(mp3DurationSeconds(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("npm test é offline", () => {
  it("o transporte padrão (fetch) para a ElevenLabs é bloqueado na suíte", async () => {
    const p = new ElevenLabsAudioProvider({ pricing: flash, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 1000 });
    await expect(p.generateAudio(REQUEST)).rejects.toThrow(/conexão/);
  });
});
