import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { DURATION_TARGETS, wordWindow, type DurationTarget, type TargetDuration } from "@/config/duration-targets";
import { CreativePlanSchema, type CreativePlan } from "@/domain/creative";
import { MasterScriptSchema, type MasterScript, type ScriptBeat, type ScriptPersona } from "@/domain/master-script";
import type { ContinuityAction } from "@/domain/edit";
import { isUgcPersonSource } from "@/domain/ugc";
import { countWords, findUgcSpeechViolations } from "./ugc-script";
import { NATURAL_CTA, STYLE_BLOCKERS, styleWarnings } from "./ugc-style-guide";

/**
 * Roteiro mestre (Lote 6), PURO: normaliza → valida → divide em segmentos contíguos nas
 * fronteiras de frase → cada A-roll recebe o seu segmento. O texto nunca é reescrito com
 * conteúdo novo; só espaços/pontuação são normalizados deterministicamente.
 */

/** Limite físico de um trecho (Veo gera até 8s). */
const MAX_SEGMENT_SECONDS = 8;

export const DEFAULT_PERSONA: ScriptPersona = {
  personaId: "persona_default", tone: "natural e simpática", speakingStyle: "conversa de celular, frases curtas", pace: "natural", vocabulary: "conversational_pt_br",
};

export function personaFor(avatar?: { id: string; name: string; personality?: string; speakingStyle?: string }, override?: { tone?: string }): ScriptPersona {
  return {
    personaId: avatar ? `persona_${avatar.id}` : DEFAULT_PERSONA.personaId,
    ...(avatar ? { avatarId: avatar.id, avatarName: avatar.name } : {}),
    tone: override?.tone?.trim() || avatar?.personality?.trim() || DEFAULT_PERSONA.tone,
    speakingStyle: avatar?.speakingStyle?.trim() || DEFAULT_PERSONA.speakingStyle,
    pace: /anima|energ|r[áa]pid/i.test(override?.tone ?? avatar?.personality ?? "") ? "lively" : /calm|devagar|tranquil/i.test(override?.tone ?? avatar?.personality ?? "") ? "calm" : "natural",
    vocabulary: "conversational_pt_br",
  };
}

/** Normalização determinística (não muda palavras). */
export function normalizeScriptText(raw: string): { text: string; normalizations: string[] } {
  const normalizations: string[] = [];
  let text = raw.replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
  if (text !== raw.trim()) normalizations.push("Espaços e aspas normalizados.");
  const spaced = text.replace(/\s+([,.!?;:])/g, "$1").replace(/([,.!?;:])(?=[^\s\d.,!?])/g, "$1 ");
  if (spaced !== text) { normalizations.push("Pontuação ajustada."); text = spaced; }
  if (text && !/[.!?]$/.test(text)) { text = `${text}.`; normalizations.push("Ponto final acrescentado."); }
  return { text, normalizations };
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Frases longas demais para um trecho são quebradas na vírgula mais central (nunca no meio de palavra). */
function unitsFor(sentences: readonly string[], parts: number): string[] {
  const units = [...sentences];
  while (units.length < parts) {
    let longest = -1;
    units.forEach((u, i) => { if (u.includes(",") && (longest < 0 || countWords(u) > countWords(units[longest]!))) longest = i; });
    if (longest < 0) break;
    const unit = units[longest]!;
    const commas = [...unit.matchAll(/,/g)].map((m) => m.index!);
    const middle = commas.reduce((best, c) => (Math.abs(c - unit.length / 2) < Math.abs(best - unit.length / 2) ? c : best), commas[0]!);
    units.splice(longest, 1, unit.slice(0, middle + 1).trim(), unit.slice(middle + 1).trim());
  }
  return units;
}

/** Frase que CONTINUA o pensamento anterior ("E…", "Então…", "Porque…"): não começa trecho novo. */
const CONTINUES_THOUGHT = /^(e|então|entao|mas|porque|pois|que|só que|so que|ou seja|aí|ai|daí|dai|inclusive|tipo)(?![\p{L}\p{N}])/iu;

/** Máximo de palavras que cabe num trecho de 8s em ritmo natural (nunca acelerar a fala). */
export const MAX_SEGMENT_WORDS = Math.floor(MAX_SEGMENT_SECONDS * UGC_MAX_WORDS_PER_SECOND);

/** Custo de cortar DEPOIS de `units[end - 1]` (Lote 6.2): meio de frase e meio de pensamento custam caro. */
function boundaryPenalty(units: readonly string[], end: number): number {
  if (end >= units.length) return 0;
  let penalty = 0;
  if (!/[.!?]$/.test(units[end - 1]!)) penalty += 25; // pausa de vírgula: aceitável, mas pior que fim de frase
  if (CONTINUES_THOUGHT.test(units[end]!)) penalty += 40; // o próximo trecho começaria no meio do pensamento
  return penalty;
}

/**
 * Divide em `parts` grupos CONTÍGUOS de frases (DP). Lote 6.2 (Script V2): não é divisão por
 * quantidade igual de palavras — o custo soma o desvio do tamanho ideal, a penalidade de cortar no
 * meio de um pensamento (próxima frase começa com "e/então/porque…") ou numa vírgula, e um custo
 * proibitivo para trecho que não caberia em 8s. A última frase (CTA) fica sempre no último segmento.
 */
export function splitMasterScript(text: string, parts: number): string[] {
  if (parts < 1) throw new Error("Número de segmentos inválido.");
  const units = unitsFor(splitSentences(text), parts);
  if (units.length < parts) throw new Error(`O roteiro tem ${units.length} frase(s); são necessários ${parts} trechos. Escreva frases mais curtas.`);
  const words = units.map(countWords);
  const ideal = words.reduce((a, b) => a + b, 0) / parts;
  const n = units.length;
  const prefix = [0];
  for (const w of words) prefix.push(prefix[prefix.length - 1]! + w);
  const cost: number[][] = Array.from({ length: parts + 1 }, () => Array<number>(n + 1).fill(Infinity));
  const back: number[][] = Array.from({ length: parts + 1 }, () => Array<number>(n + 1).fill(-1));
  cost[0]![0] = 0;
  for (let k = 1; k <= parts; k++) {
    for (let j = k; j <= n - (parts - k); j++) {
      for (let i = k - 1; i < j; i++) {
        const prev = cost[k - 1]![i]!;
        if (prev === Infinity) continue;
        const w = prefix[j]! - prefix[i]!;
        const c = prev + (w - ideal) ** 2 + boundaryPenalty(units, j) + Math.max(0, w - MAX_SEGMENT_WORDS) * 1000;
        if (c < cost[k]![j]!) { cost[k]![j] = c; back[k]![j] = i; }
      }
    }
  }
  const segments: string[] = [];
  let j = n;
  for (let k = parts; k >= 1; k--) {
    const i = back[k]![j]!;
    segments.unshift(units.slice(i, j).join(" "));
    j = i;
  }
  return segments;
}

export interface MasterScriptCheck {
  /** Bloqueiam o roteiro (o LLM recebe o erro para corrigir). */
  issues: string[];
  /** Não justificam nova chamada paga. */
  warnings: string[];
}

export function checkMasterScript(text: string, target: DurationTarget): MasterScriptCheck {
  const issues: string[] = [];
  const words = countWords(text);
  const window = wordWindow(target);
  if (words < window.min || words > window.max) issues.push(`Roteiro mestre com ${words} palavras; para ${target.label} o alvo é ${target.words.min}–${target.words.max}.`);
  for (const reason of findUgcSpeechViolations(text)) issues.push(`Fala proibida: ${reason}.`);
  for (const blocker of STYLE_BLOCKERS) if (blocker.pattern.test(text)) issues.push(`Estilo: ${blocker.reason}.`);
  const last = splitSentences(text).at(-1) ?? "";
  if (!NATURAL_CTA.test(last)) issues.push("A última frase do roteiro mestre deve ser o CTA natural (ex.: \"dá uma olhada no carrinho\").");
  return { issues, warnings: styleWarnings(text) };
}

function sectionsOf(sentences: readonly string[]): MasterScript["sections"] {
  const hook = sentences[0] ?? "";
  const cta = sentences.at(-1) ?? "";
  const middle = sentences.slice(1, -1);
  const closing = middle.length >= 3 ? middle.at(-1)! : "";
  const rest = closing ? middle.slice(0, -1) : middle;
  const half = Math.ceil(rest.length / 2);
  return { hook, body: rest.slice(0, half).join(" "), demo: rest.slice(half).join(" "), closing, cta };
}

/** Constrói o roteiro mestre e os segmentos (um por A-roll). Lança se não der para dividir. */
export function buildMasterScript(input: { text: string; target: DurationTarget; persona: ScriptPersona; sceneIds?: readonly string[]; parts?: number }): MasterScript {
  const { text, normalizations } = normalizeScriptText(input.text);
  const parts = input.sceneIds?.length ?? input.parts ?? input.target.clips;
  const segments = splitMasterScript(text, parts);
  const check = checkMasterScript(text, input.target);
  return MasterScriptSchema.parse({
    version: 1, text, wordCount: countWords(text), targetSeconds: input.target.seconds, targetWords: input.target.words,
    sections: sectionsOf(splitSentences(text)), persona: input.persona,
    segments: enrichSegments(segments).map((extra, index) => ({
      index, text: segments[index]!, wordCount: countWords(segments[index]!), personaId: input.persona.personaId, containsCta: index === segments.length - 1,
      ...(input.sceneIds?.[index] ? { sceneId: input.sceneIds[index] } : {}),
      ...extra,
    })),
    normalizations, warnings: [...check.warnings, ...check.issues.map((i) => `Aceito com ressalva: ${i}`)],
  });
}

/** Menor duração (0,1s) em que a fala cabe no ritmo natural, sem passar do limite físico do clipe. */
export function durationForSpeech(words: number, current: number): number {
  const needed = Math.ceil((words / UGC_MAX_WORDS_PER_SECOND) * 10 + 1e-9) / 10;
  return Math.round(Math.min(MAX_SEGMENT_SECONDS, Math.max(current, needed)) * 100) / 100;
}

/**
 * Correção Lote 6 (campaign-plan@1.8.1) — normalização DETERMINÍSTICA do rascunho do LLM antes
 * da validação: o roteiro mestre (`script`) é re-dividido pelo próprio sistema nas fronteiras de
 * frase (a divisão do LLM é só sugestão) e cada trecho ganha a duração em que a sua fala cabe
 * (até 8s). Assim uma divisão desigual — ex.: o nome longo do produto num trecho de 6,6s — não
 * vira "plano inválido" nem nova chamada paga. Nunca muda palavras; formato inesperado passa intacto.
 */
export function normalizeMasterScriptDraft(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { creatives?: unknown }).creatives)) return raw;
  const draft = raw as { creatives: unknown[] };
  return { ...draft, creatives: draft.creatives.map(normalizeCreativeDraft) };
}

type RawScene = { visualSource?: unknown; narration?: unknown; duration?: unknown; estimatedGenerationSeconds?: unknown };

function normalizeCreativeDraft(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const creative = raw as { script?: unknown; duration?: unknown; scenes?: unknown };
  if (!Array.isArray(creative.scenes) || !creative.scenes.every((s) => s && typeof s === "object")) return raw;
  const scenes = creative.scenes as RawScene[];
  const arolls = scenes.filter((s) => typeof s.visualSource === "string" && isUgcPersonSource(s.visualSource as never));
  // Só Presenter Only puro (todas as cenas da apresentadora) e com campos no formato esperado.
  if (arolls.length === 0 || arolls.length !== scenes.length || !scenes.every((s) => typeof s.narration === "string" && typeof s.duration === "number")) return raw;
  const source = typeof creative.script === "string" && creative.script.trim() ? creative.script : scenes.map((s) => (s.narration as string).trim()).join(" ");
  const { text } = normalizeScriptText(source);
  let segments: string[];
  try { segments = splitMasterScript(text, scenes.length); } catch { return raw; }
  const next = scenes.map((scene, i) => {
    const duration = durationForSpeech(countWords(segments[i]!), scene.duration as number);
    return { ...scene, narration: segments[i]!, duration, ...(typeof scene.estimatedGenerationSeconds === "number" ? { estimatedGenerationSeconds: duration } : {}) };
  });
  return { ...creative, script: text, scenes: next, duration: Math.round(next.reduce((sum, s) => sum + s.duration, 0) * 100) / 100 };
}

/**
 * Aplica o roteiro mestre a um criativo AI UGC: o `script` do plano é o mestre; a fala de cada
 * A-roll passa a ser o segmento correspondente. Hook e CTA do plano vêm do próprio roteiro.
 */
export function applyMasterScript(creative: CreativePlan, options: { duration: TargetDuration; persona: ScriptPersona }): CreativePlan {
  const arolls = creative.scenes.filter((s) => isUgcPersonSource(s.visualSource));
  if (arolls.length === 0) return creative;
  const source = creative.script.trim() || arolls.map((s) => s.narration.trim()).join(" ");
  const master = buildMasterScript({ text: source, target: DURATION_TARGETS[options.duration], persona: options.persona, sceneIds: arolls.map((s) => s.id) });
  const bySceneId = new Map(master.segments.map((s) => [s.sceneId!, s]));
  // Cada trecho dura o suficiente para a SUA fala (até 8s): a divisão determinística manda.
  const scenes = creative.scenes.map((s) => {
    const segment = bySceneId.get(s.id);
    if (!segment) return s;
    const duration = durationForSpeech(segment.wordCount, s.duration);
    // Script V2: a ação visual acompanha a fala (feature → contexto → ação) e vira a ação do vídeo.
    const videoDirection = s.videoDirection && segment.visualAction ? { ...s.videoDirection, subjectAction: segment.visualAction } : s.videoDirection;
    return { ...s, narration: segment.text, duration, ...(videoDirection ? { videoDirection } : {}), ...(s.requiresGeneratedVideo ? { estimatedGenerationSeconds: duration } : {}) };
  });
  return CreativePlanSchema.parse({
    ...creative,
    script: master.text,
    hook: master.sections.hook || creative.hook,
    callToAction: master.sections.cta,
    scenes,
    duration: Math.round(scenes.filter((s) => !s.edit?.overlay).reduce((sum, s) => sum + s.duration, 0) * 100) / 100,
    masterScript: master,
  });
}

// ---------------------------------------------------------------- Lote 6.2 — Script V2

/** Beat de cada segmento: 1º = hook, último = fechamento/CTA, o meio segue a estrutura V2. */
export function beatsFor(count: number): ScriptBeat[] {
  const middle: ScriptBeat[] = ["main_feature", "second_feature_demo", "important_info"];
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return "hook";
    if (i === count - 1) return "closing_cta";
    return middle[Math.min(middle.length - 1, Math.floor(((i - 1) * middle.length) / Math.max(1, count - 2)))]!;
  });
}

/** Ação visual padrão por beat (o que ela FAZ enquanto fala) e a ação com que o trecho termina. */
const BEAT_ACTIONS: Record<ScriptBeat, { visualAction: string; exitAction: ContinuityAction }> = {
  hook: { visualAction: "raises the product to chest height while talking to the camera", exitAction: "raise_product" },
  main_feature: { visualAction: "slowly turns the product to show the feature being mentioned", exitAction: "rotate_product" },
  second_feature_demo: { visualAction: "demonstrates the product with a natural hand movement", exitAction: "rotate_product" },
  important_info: { visualAction: "points at the part of the product being mentioned", exitAction: "point_detail" },
  closing_cta: { visualAction: "brings the product a little closer to the camera and smiles; after the last word glances at the product and lowers it slightly", exitAction: "lower_product" },
};

/** Pistas no TEXTO do segmento: a ação visual acompanha o que está sendo dito (feature → contexto → ação). */
const VISUAL_CUES: readonly { pattern: RegExp; visualAction: string; exitAction: ContinuityAction }[] = [
  { pattern: /(?<![\p{L}])(bicos?|ponteira|bocal|concentrador|direcionador|difusor)(?![\p{L}])/iu, visualAction: "shows the nozzle up close, turning the product", exitAction: "rotate_product" },
  { pattern: /(?<![\p{L}])(bot[ãa]o|bot[õo]es|temperaturas?|velocidades?|controles?|ajustes?|n[íi]veis)(?![\p{L}])/iu, visualAction: "points at the buttons with the free hand", exitAction: "point_detail" },
  { pattern: /(?<![\p{L}])(cabo|fio)(?![\p{L}])/iu, visualAction: "shows the cable, lowering the product a little", exitAction: "lower_product" },
  { pattern: /(?<![\p{L}])(tamanho|formato|leve|peso|cabe na m[ãa]o)(?![\p{L}])/iu, visualAction: "holds the product closer to the camera to show its size", exitAction: "move_product_closer" },
  { pattern: /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s?(w|watts?|v|volts?|ml|l|mah)(?![\p{L}])/iu, visualAction: "turns the product to show its side while mentioning the specification", exitAction: "rotate_product" },
];

const MOVING: readonly ContinuityAction[] = ["raise_product", "rotate_product", "point_detail", "look_product_to_camera", "move_product_closer", "lower_product", "shift_body"];

/**
 * Enriquece cada segmento (determinístico): beat, ação visual, ação de entrada (= saída do
 * anterior: cut on action), ação de saída, transição pretendida e motivo do corte.
 */
export function enrichSegments(texts: readonly string[]): Pick<MasterScript["segments"][number], "beat" | "visualAction" | "entryAction" | "exitAction" | "transitionIntent" | "splitReason">[] {
  const beats = beatsFor(texts.length);
  let previousExit: ContinuityAction | undefined;
  return texts.map((text, i) => {
    const beat = beats[i]!;
    const cue = beat === "closing_cta" ? undefined : VISUAL_CUES.find((c) => c.pattern.test(text));
    const { visualAction, exitAction } = cue ?? BEAT_ACTIONS[beat];
    const entryAction = previousExit ?? "hold_still";
    const transitionIntent = i === 0 ? "opening" as const : MOVING.includes(entryAction) ? "cut_on_action" as const : "micro_punch" as const;
    const previousText = texts[i - 1];
    const splitReason = i === 0 ? "opening" as const
      : !/[.!?]$/.test(previousText ?? "") ? "natural_pause" as const
      : cue ? "visual_action" as const : CONTINUES_THOUGHT.test(text) ? "sentence_end" as const : "thought_end" as const;
    previousExit = exitAction;
    return { beat, visualAction, entryAction, exitAction, transitionIntent, splitReason };
  });
}

/** "Secador de Cabelos Profissional Color Wind Santa Clara 2100W 220V" → "secador de cabelos". */
export function shortProductName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const beforeSpec = words.slice(0, Math.max(1, words.findIndex((w) => /\d/.test(w)) === -1 ? words.length : words.findIndex((w) => /\d/.test(w))));
  if (beforeSpec.length <= 3) return beforeSpec.join(" ").toLowerCase();
  const short = /^(de|da|do|das|dos|para|pra)$/i.test(beforeSpec[1]!) ? beforeSpec.slice(0, 3) : beforeSpec.slice(0, 1);
  return short.join(" ").toLowerCase();
}

/** Muletas que, repetidas, deixam o roteiro com cara de lista lida. */
export const FILLER_PHRASES = ["esse modelo", "esse aqui", "olha só", "vou mostrar", "confere"] as const;
/** Linguagem de ficha técnica / catálogo (nunca é como alguém fala no celular). */
/** Palavra(s) inteira(s) com fronteira Unicode (o `\b` do JS não entende "é", "são"…). */
const words = (body: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);

const SPEC_SHEET_PHRASES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: words("(?:é|e|são) vendid[oa]s? como"), reason: "\"ele é vendido como…\"" },
  { pattern: words("(?:este|esse) (?:produto|equipamento|item|aparelho) (?:possui|oferece|conta com|apresenta)"), reason: "\"este produto possui/oferece…\"" },
  { pattern: words("possui as seguintes|ficha t[ée]cnica|especifica[çc][õo]es t[ée]cnicas"), reason: "linguagem de catálogo" },
];
/** Frase curta declarativa de especificação ("Ele é 220V.", "A potência dele é de 2100W."). */
const SPEC_LINE = new RegExp(
  "^(?:ele|ela|esse|este|essa|esta|o produto|a pot[êe]ncia(?: dele| dela)?|a voltagem(?: dele| dela)?|a tens[ãa]o(?: dele| dela)?)(?![\\p{L}])[^.!?]{0,60}(?<![\\p{L}])(?:é|tem|possui|vem|fica)(?![\\p{L}])",
  "iu",
);

function countPhrase(text: string, phrase: string): number {
  const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Fronteira de palavra sem \b (que não entende acentos): início/fim ou caractere não-letra.
  return (strip(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${strip(phrase).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "gu")) ?? []).length;
}

/**
 * Lote 6.2 — Script V2: o roteiro não pode soar como ficha técnica. Bloqueia (o Claude recebe o
 * motivo): frases de catálogo, ≥ 3 frases curtas seguidas de especificação solta, muleta repetida
 * mais de 2× (ou > 4 no total) e mais de 3 frases começando com "Ele".
 */
export function checkScriptV2(text: string): string[] {
  const issues: string[] = [];
  for (const { pattern, reason } of SPEC_SHEET_PHRASES) if (pattern.test(text)) issues.push(`Linguagem de ficha técnica: ${reason}. Use FEATURE → CONTEXTO → AÇÃO VISUAL.`);
  const sentences = splitSentences(text);
  let run = 0;
  let worst = 0;
  for (const s of sentences) {
    run = SPEC_LINE.test(s) && countWords(s) <= 9 ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  if (worst >= 3) issues.push(`Roteiro soa como lista de especificações (${worst} frases curtas seguidas do tipo "Ele é/tem X."). Junte a característica ao contexto e ao que ela mostra.`);
  let fillers = 0;
  for (const phrase of FILLER_PHRASES) {
    const n = countPhrase(text, phrase);
    fillers += n;
    if (n > 2) issues.push(`Repetição: "${phrase}" aparece ${n} vezes (máx. 2).`);
  }
  if (fillers > 4) issues.push(`Muletas demais (${fillers}): ${FILLER_PHRASES.join(", ")}.`);
  const ele = sentences.filter((s) => /^ele(?![\p{L}\p{N}])/iu.test(s)).length;
  if (ele > 3) issues.push(`${ele} frases começam com "Ele": varie a construção.`);
  return issues;
}
