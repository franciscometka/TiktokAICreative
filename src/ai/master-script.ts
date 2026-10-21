import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { DURATION_TARGETS, wordWindow, type DurationTarget, type TargetDuration } from "@/config/duration-targets";
import { CreativePlanSchema, type CreativePlan } from "@/domain/creative";
import { MasterScriptSchema, type MasterScript, type ScriptPersona } from "@/domain/master-script";
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

/**
 * Divide em `parts` grupos CONTÍGUOS de frases, equilibrando palavras (DP: menor soma dos
 * quadrados do desvio). A última frase (CTA) fica sempre no último segmento.
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
        const c = prev + (prefix[j]! - prefix[i]! - ideal) ** 2;
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
    segments: segments.map((segment, index) => ({
      index, text: segment, wordCount: countWords(segment), personaId: input.persona.personaId, containsCta: index === segments.length - 1,
      ...(input.sceneIds?.[index] ? { sceneId: input.sceneIds[index] } : {}),
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
    return { ...s, narration: segment.text, duration, ...(s.requiresGeneratedVideo ? { estimatedGenerationSeconds: duration } : {}) };
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
