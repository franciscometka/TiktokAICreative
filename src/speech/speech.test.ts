import { describe, expect, it } from "vitest";
import type { CharacterTiming } from "@/domain/audio";
import { CAPTION_LIMITS } from "@/render/captions";
import { AlignmentMismatchError, narrationTiming, wordsFromAlignment } from "./alignment";
import { evaluateAudioFit } from "./audio-fit";
import { buildNarrationScript, buildScript, speakToken, spokenNarrationCharacters } from "./narration-script";
import { currencyToWordsPtBr, numberToWordsPtBr } from "./numbers-pt-br";
import { captionsFromWords } from "./timed-captions";

/** Timing falso: cada caractere do texto falado dura `spc` segundos. */
function timingFor(spoken: string, spc = 0.05): CharacterTiming {
  const chars = spoken.split("");
  return {
    characters: chars,
    startSeconds: chars.map((_, i) => Math.round(i * spc * 1000) / 1000),
    endSeconds: chars.map((_, i) => Math.round((i + 1) * spc * 1000) / 1000),
  };
}

describe("números por extenso (pt-BR)", () => {
  it.each([
    [0, "zero"],
    [1, "um"],
    [12, "doze"],
    [21, "vinte e um"],
    [79, "setenta e nove"],
    [100, "cem"],
    [101, "cento e um"],
    [750, "setecentos e cinquenta"],
    [1000, "mil"],
    [1100, "mil e cem"],
    [1250, "mil duzentos e cinquenta"],
    [2500, "dois mil e quinhentos"],
    [1_000_000, "um milhão"],
    [2_300_000, "dois milhões e trezentos mil"],
  ])("%i → %s", (n, words) => {
    expect(numberToWordsPtBr(n)).toBe(words);
  });

  it("feminino: duas horas, duzentas peças", () => {
    expect(numberToWordsPtBr(2, { feminine: true })).toBe("duas");
    expect(numberToWordsPtBr(200, { feminine: true })).toBe("duzentas");
  });

  it("dinheiro", () => {
    expect(currencyToWordsPtBr(79, 90)).toBe("setenta e nove reais e noventa centavos");
    expect(currencyToWordsPtBr(1, 0)).toBe("um real");
    expect(currencyToWordsPtBr(0, 50)).toBe("cinquenta centavos");
    expect(() => numberToWordsPtBr(-1)).toThrow(RangeError);
  });
});

describe("texto falado da narração", () => {
  it('"R$ 79,90" vira fala por extenso, mas a legenda continua "R$ 79,90"', () => {
    const script = buildScript([{ sceneId: "s1", text: "Por apenas R$ 79,90." }]);
    expect(script.spoken).toBe("Por apenas setenta e nove reais e noventa centavos.");
    expect(script.tokens.map((t) => t.written)).toEqual(["Por", "apenas", "R$ 79,90."]);
  });

  it("aceita espaço inseparável do Intl e milhar com ponto", () => {
    expect(speakToken("R$ 79,90", undefined)).toBe("setenta e nove reais e noventa centavos");
    expect(speakToken("R$ 1.299,00", undefined)).toBe("mil duzentos e noventa e nove reais");
  });

  it("unidades, porcentagem, decimais e gênero do substantivo seguinte", () => {
    expect(speakToken("750ml", undefined)).toBe("setecentos e cinquenta mililitros");
    expect(speakToken("24h,", undefined)).toBe("vinte e quatro horas,");
    expect(speakToken("1h", undefined)).toBe("uma hora");
    expect(speakToken("100%", undefined)).toBe("cem por cento");
    expect(speakToken("1,5", undefined)).toBe("um vírgula cinco");
    expect(speakToken("2", "horas")).toBe("duas");
    expect(speakToken("2", "copos")).toBe("dois");
  });

  it("palavras comuns e pontuação ficam como estão", () => {
    expect(speakToken("gelada?", undefined)).toBe("gelada?");
    expect(speakToken("“Água", undefined)).toBe("“Água");
  });

  it("narração contínua: falas das cenas na ordem, vazias ignoradas, determinística", () => {
    const plan = {
      scenes: [
        { id: "a", narration: "Sua água esquenta?" },
        { id: "b", narration: "" },
        { id: "c", narration: "Essa garrafa segura 12 horas." },
      ],
    } as never;
    const s = buildNarrationScript(plan);
    expect(s.spoken).toBe("Sua água esquenta? Essa garrafa segura doze horas.");
    expect(s.tokens.map((t) => t.sceneId)).toEqual(["a", "a", "a", "c", "c", "c", "c", "c"]);
    expect(buildNarrationScript(plan)).toEqual(s);
    expect(spokenNarrationCharacters(plan)).toBe(s.spoken.length);
  });

  it("offsets de cada token apontam para o trecho falado", () => {
    const s = buildScript([{ sceneId: null, text: "Só R$ 10,00 hoje" }]);
    for (const t of s.tokens) expect(s.spoken.slice(t.spokenStart, t.spokenEnd).length).toBeGreaterThan(0);
    expect(s.spoken.slice(s.tokens[1]!.spokenStart, s.tokens[1]!.spokenEnd)).toBe("dez reais");
  });
});

describe("alinhamento → palavras com tempo real", () => {
  const script = buildScript([
    { sceneId: "s1", text: "Sua água esquenta antes do almoço?" },
    { sceneId: "s2", text: "Por R$ 79,90, gelada até a noite." },
  ]);

  it("cada palavra escrita recebe o início do 1º caractere e o fim do último (pontuação incluída)", () => {
    const words = wordsFromAlignment(script, timingFor(script.spoken));
    expect(words.map((w) => w.text)).toEqual([
      "Sua", "água", "esquenta", "antes", "do", "almoço?", "Por", "R$ 79,90,", "gelada", "até", "a", "noite.",
    ]);
    expect(words[0]).toMatchObject({ startSeconds: 0, endSeconds: 0.15, sceneId: "s1" });
    const price = words[7]!;
    const spokenPrice = "setenta e nove reais e noventa centavos,";
    expect(price.endSeconds - price.startSeconds).toBeCloseTo(spokenPrice.length * 0.05, 2);
    for (let i = 1; i < words.length; i++) expect(words[i]!.startSeconds).toBeGreaterThanOrEqual(words[i - 1]!.endSeconds);
  });

  it("janelas por cena e fim real da fala (para lip sync/avatar no futuro)", () => {
    const t = narrationTiming(script, timingFor(script.spoken));
    expect(t.scenes.map((s) => s.sceneId)).toEqual(["s1", "s2"]);
    expect(t.scenes[0]!.endSeconds).toBeLessThanOrEqual(t.scenes[1]!.startSeconds);
    expect(t.speechEndSeconds).toBeCloseTo(script.spoken.length * 0.05, 2);
  });

  it("alinhamento de outro texto → AlignmentMismatchError (nunca inventa timing)", () => {
    expect(() => wordsFromAlignment(script, timingFor(`${script.spoken}!`))).toThrow(AlignmentMismatchError);
  });
});

describe("legendas com timing real", () => {
  const script = buildScript([
    { sceneId: "s1", text: "Sua água esquenta antes do almoço? Essa garrafa de inox mantém tudo gelado." },
    { sceneId: "s2", text: "Toca no carrinho." },
  ]);
  const words = wordsFromAlignment(script, timingFor(script.spoken, 0.06));
  const captions = captionsFromWords(words);

  it("respeita limites, quebra na pontuação e na troca de cena", () => {
    // "Sua água esquenta antes do almoço?" tem 34 caracteres: passa do limite e quebra antes.
    expect(captions[0]?.text).toBe("Sua água esquenta antes do");
    for (const c of captions) {
      expect(c.text.length).toBeLessThanOrEqual(Math.max(CAPTION_LIMITS.maxChars, 34));
      expect(c.text.split(" ").length).toBeLessThanOrEqual(CAPTION_LIMITS.maxWords);
    }
    expect(captions[captions.length - 1]?.text).toBe("Toca no carrinho.");
    expect(captions.map((c) => c.text).join(" ")).toBe(script.written);
  });

  it("começa quando a fala começa e não se sobrepõe ao próximo trecho", () => {
    expect(captions[0]?.startSeconds).toBe(0);
    // Cada trecho começa exatamente quando a sua primeira palavra começa a ser falada.
    let w = 0;
    for (const c of captions) {
      expect(c.startSeconds).toBe(words[w]!.startSeconds);
      w += c.text.split(" ").length - (c.text.includes("R$ ") ? 1 : 0);
    }
    for (let i = 1; i < captions.length; i++) expect(captions[i]!.startSeconds).toBeGreaterThanOrEqual(captions[i - 1]!.endSeconds);
  });
});

describe("AudioFit", () => {
  it("cabe dentro da tolerância", () => {
    expect(evaluateAudioFit({ targetSeconds: 25, speechSeconds: 24.5, measured: true })).toMatchObject({
      status: "fits",
      action: "none",
      difference: -0.5,
      extendSeconds: 0,
    });
  });

  it("fala encostando no fim: estende só o respiro final", () => {
    const fit = evaluateAudioFit({ targetSeconds: 25, speechSeconds: 25.2, measured: true });
    expect(fit).toMatchObject({ status: "fits", action: "extend" });
    expect(fit.extendSeconds).toBeCloseTo(0.6, 3);
  });

  it("fala mais curta: too_short sem mudar nada", () => {
    expect(evaluateAudioFit({ targetSeconds: 25, speechSeconds: 18, measured: true })).toMatchObject({ status: "too_short", action: "none", difference: -7 });
  });

  it("excede pouco (≤ max(2s, 10%)): estende o fim localmente, sem cortar fala", () => {
    const fit = evaluateAudioFit({ targetSeconds: 25, speechSeconds: 27, measured: true });
    expect(fit).toMatchObject({ status: "too_long", action: "extend", difference: 2 });
    expect(fit.extendSeconds).toBeCloseTo(2.4, 3);
  });

  it("excede muito: exige revisão explícita", () => {
    const fit = evaluateAudioFit({ targetSeconds: 25, speechSeconds: 31, measured: true });
    expect(fit).toMatchObject({ status: "too_long", action: "review", targetDuration: 25, actualDuration: 31, difference: 6 });
  });

  it("áudio mock nunca pede revisão nem estende", () => {
    expect(evaluateAudioFit({ targetSeconds: 25, speechSeconds: 60, measured: false })).toMatchObject({ status: "too_long", action: "none", extendSeconds: 0 });
  });
});
