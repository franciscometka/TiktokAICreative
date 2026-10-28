import { describe, expect, it } from "vitest";
import { DURATION_TARGETS, TARGET_DURATIONS } from "@/config/duration-targets";
import { product } from "@/test/fixtures";
import { buildMasterScript, checkMasterScript, DEFAULT_PERSONA, normalizeScriptText, personaFor, splitMasterScript, splitSentences } from "./master-script";
import { buildMockMasterScriptText } from "./mock-ugc-planner";
import { countWords } from "./ugc-script";

const SCRIPT = "Se você está procurando um secador potente, olha esse modelo aqui. Esse é o Secador Pro 2100. Ele tem 2100 watts e três temperaturas. Repara no bico concentrador, encaixa fácil. Olha aqui de lado, girando devagar. O cabo é longo e dá pra usar com calma. O acabamento é bem feito. Então é isso, esse é o modelo. Se você curtiu esse modelo, dá uma olhada no carrinho e confere os detalhes.";

describe("Roteiro mestre (Lote 6)", () => {
  it("UM texto vira segmentos CONTÍGUOS nas fronteiras de frase, sem mudar palavras", () => {
    const parts = splitMasterScript(SCRIPT, 5);
    expect(parts).toHaveLength(5);
    expect(parts.join(" ")).toBe(SCRIPT);
    for (const part of parts) expect(part).toMatch(/[.!?]$/);
    // Equilibrado: nenhum segmento com mais que o dobro da média de palavras.
    const avg = countWords(SCRIPT) / 5;
    for (const part of parts) expect(countWords(part)).toBeLessThan(avg * 2);
  });

  it("CTA pertence ao roteiro: é a última frase e fica no último segmento", () => {
    const master = buildMasterScript({ text: SCRIPT, target: DURATION_TARGETS[30], persona: DEFAULT_PERSONA, parts: 5 });
    expect(master.sections.cta).toBe("Se você curtiu esse modelo, dá uma olhada no carrinho e confere os detalhes.");
    expect(master.segments.at(-1)!.text.endsWith(master.sections.cta)).toBe(true);
    expect(master.segments.at(-1)!.containsCta).toBe(true);
    expect(master.segments.slice(0, -1).every((s) => !s.containsCta)).toBe(true);
    expect(master.sections.hook).toBe(splitSentences(SCRIPT)[0]);
  });

  it("segmentação não muda a persona: todos os segmentos herdam o mesmo personaId", () => {
    const persona = personaFor({ id: "avatar_marina", name: "Marina", personality: "Natural e simpática", speakingStyle: "frases curtas" });
    const master = buildMasterScript({ text: SCRIPT, target: DURATION_TARGETS[30], persona, sceneIds: ["s1", "s2", "s3", "s4", "s5"] });
    expect(new Set(master.segments.map((s) => s.personaId))).toEqual(new Set(["persona_avatar_marina"]));
    expect(master.persona).toMatchObject({ avatarName: "Marina", tone: "Natural e simpática", vocabulary: "conversational_pt_br" });
    expect(master.segments.map((s) => s.sceneId)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("frase longa é quebrada na vírgula quando faltam frases para os trechos", () => {
    const parts = splitMasterScript("Olha esse modelo, ele é leve, cabe na bolsa. Dá uma olhada no carrinho.", 3);
    expect(parts).toHaveLength(3);
    expect(parts.join(" ")).toBe("Olha esse modelo, ele é leve, cabe na bolsa. Dá uma olhada no carrinho.");
  });

  it("normalização determinística: só espaços/pontuação, nunca palavras", () => {
    const { text, normalizations } = normalizeScriptText('  "Olha isso"  aqui ,repara   no carrinho ');
    expect(text).toBe("Olha isso aqui, repara no carrinho.");
    expect(normalizations.length).toBeGreaterThan(0);
  });

  it("faixas por duração são guidance com tolerância (não regra de 1 palavra)", () => {
    const target = DURATION_TARGETS[30];
    const words = (n: number) => `${Array.from({ length: n - 7 }, () => "palavra").join(" ")}. Dá uma olhada no carrinho e confere.`;
    expect(checkMasterScript(words(68), target).issues).toEqual([]); // 68 < 70, dentro dos 15%
    expect(checkMasterScript(words(40), target).issues[0]).toMatch(/40 palavras/);
  });

  it("style guide: bloqueia urgência/garantia/clickbait e exige CTA natural no fim", () => {
    const target = DURATION_TARGETS[30];
    const bad = `${"Olha esse modelo aqui. ".repeat(14)}Corra que é garantido!!`;
    const issues = checkMasterScript(bad, target).issues.join(" ");
    expect(issues).toMatch(/garantia/);
    expect(issues).toMatch(/urgência/);
    expect(issues).toMatch(/CTA natural/);
  });

  it.each(TARGET_DURATIONS)("mock gera roteiro mestre de %is dentro da faixa e divisível nos trechos", (seconds) => {
    const target = DURATION_TARGETS[seconds];
    const text = buildMockMasterScriptText(product({ features: ["2100 watts", "3 temperaturas"], benefits: ["secagem rápida"] }), target);
    const words = countWords(text);
    expect(words).toBeGreaterThanOrEqual(Math.floor(target.words.min * 0.85));
    expect(words).toBeLessThanOrEqual(Math.ceil(target.words.max * 1.15));
    expect(checkMasterScript(text, target).issues).toEqual([]);
    expect(splitMasterScript(text, target.clips)).toHaveLength(target.clips);
  });
});
