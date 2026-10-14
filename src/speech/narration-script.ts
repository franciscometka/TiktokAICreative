import type { CreativePlan } from "@/domain/creative";
import { currencyToWordsPtBr, numberToWordsPtBr } from "./numbers-pt-br";

/**
 * Roteiro de narração CONTÍNUA de um criativo (D55): o texto escrito das cenas vira um único
 * texto FALADO, normalizado para pt-BR ("R$ 79,90" → "setenta e nove reais e noventa centavos"),
 * sem perder a ligação com o texto escrito: cada token escrito sabe onde está no texto falado.
 * Assim a legenda mostra "R$ 79,90" com o tempo real em que "setenta e nove reais..." foi dito.
 * Função pura e determinística: a mesma entrada gera exatamente o mesmo texto (e o mesmo custo).
 */

export interface ScriptToken {
  /** Como aparece na legenda. */
  written: string;
  /** Intervalo [spokenStart, spokenEnd) no texto falado. */
  spokenStart: number;
  spokenEnd: number;
  sceneId: string | null;
}

export interface NarrationScript {
  /** Texto escrito (para auditoria). */
  written: string;
  /** Texto enviado ao TTS. A cobrança é por caractere DESTE texto. */
  spoken: string;
  tokens: ScriptToken[];
}

const CURRENCY = /^R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/;
const NUMBER = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/;
const UNITS: Record<string, { singular: string; plural: string; feminine?: boolean }> = {
  ml: { singular: "mililitro", plural: "mililitros" },
  l: { singular: "litro", plural: "litros" },
  kg: { singular: "quilo", plural: "quilos" },
  g: { singular: "grama", plural: "gramas" },
  cm: { singular: "centímetro", plural: "centímetros" },
  mm: { singular: "milímetro", plural: "milímetros" },
  h: { singular: "hora", plural: "horas", feminine: true },
  min: { singular: "minuto", plural: "minutos" },
  x: { singular: "vez", plural: "vezes", feminine: true },
};
/** Substantivos femininos comuns depois de números ("duas horas", "duzentas peças"). */
const FEMININE_NOUNS = /^(horas?|semanas?|vezes|vez|unidades?|peças?|cores|cor|camadas?|garrafas?|opções|opção|pessoas?|noites?|cápsulas?|xícaras?|colheres?|gramas?)\b/i;

/** Tokens: "R$ 79,90" é UM token (com a pontuação colada); o resto é separado por espaço. */
const TOKEN = /R\$\s?\d[\d.]*(?:,\d{1,2})?[.,!?;:…)»"”]*|\S+/g;

function parseInteger(digits: string): number {
  return Number(digits.replaceAll(".", ""));
}

function speakNumber(intPart: string, decimals: string | undefined, feminine: boolean): string | undefined {
  const int = parseInteger(intPart);
  if (!Number.isSafeInteger(int) || int > 999_999_999) return undefined;
  const head = numberToWordsPtBr(int, { feminine });
  if (!decimals) return head;
  // "1,5" → "um vírgula cinco"; "0,75" → "zero vírgula setenta e cinco"
  const dec = Number(decimals);
  const zeros = decimals.match(/^0+/)?.[0].length ?? 0;
  const decWords = `${"zero ".repeat(zeros)}${dec === 0 ? "" : numberToWordsPtBr(dec)}`.trim();
  return `${head} vírgula ${decWords}`;
}

/** Separa pontuação de abertura/fechamento do núcleo do token. */
function splitPunctuation(token: string): { lead: string; core: string; trail: string } {
  const m = /^([("“«]*)(.*?)([.,!?;:…)"”»]*)$/s.exec(token);
  return { lead: m?.[1] ?? "", core: m?.[2] ?? token, trail: m?.[3] ?? "" };
}

/** Versão falada de UM token escrito (ou o próprio token, se não precisa normalizar). */
export function speakToken(token: string, nextWord: string | undefined): string {
  const { lead, core, trail } = splitPunctuation(token);

  const currency = CURRENCY.exec(core);
  if (currency) {
    const reais = parseInteger(currency[1] ?? "0");
    const cents = currency[2] ? Number(currency[2].padEnd(2, "0")) : 0;
    if (Number.isSafeInteger(reais) && reais <= 999_999_999) return `${lead}${currencyToWordsPtBr(reais, cents)}${trail}`;
    return token;
  }

  const percent = /^(\d[\d.]*)(?:,(\d+))?%$/.exec(core);
  if (percent) {
    const spoken = speakNumber(percent[1] ?? "", percent[2], false);
    return spoken ? `${lead}${spoken} por cento${trail}` : token;
  }

  const withUnit = /^(\d[\d.]*)(?:,(\d+))?([a-zA-Z]{1,3})$/.exec(core);
  if (withUnit) {
    const unit = UNITS[(withUnit[3] ?? "").toLowerCase()];
    if (unit) {
      const spoken = speakNumber(withUnit[1] ?? "", withUnit[2], unit.feminine ?? false);
      if (spoken) {
        const one = parseInteger(withUnit[1] ?? "") === 1 && !withUnit[2];
        return `${lead}${spoken} ${one ? unit.singular : unit.plural}${trail}`;
      }
    }
    return token;
  }

  const number = NUMBER.exec(core);
  if (number) {
    const feminine = nextWord !== undefined && FEMININE_NOUNS.test(nextWord);
    const spoken = speakNumber(number[1] ?? "", number[2], feminine);
    return spoken ? `${lead}${spoken}${trail}` : token;
  }

  return token;
}

export interface ScriptSegment {
  sceneId: string | null;
  text: string;
}

export function buildScript(segments: readonly ScriptSegment[]): NarrationScript {
  const tokens: ScriptToken[] = [];
  const written: string[] = [];
  let spoken = "";
  for (const segment of segments) {
    const words = segment.text.trim().match(TOKEN) ?? [];
    words.forEach((word, i) => {
      const next = words[i + 1];
      const said = speakToken(word, next ? splitPunctuation(next).core : undefined);
      if (spoken.length > 0) spoken += " ";
      tokens.push({ written: word, spokenStart: spoken.length, spokenEnd: spoken.length + said.length, sceneId: segment.sceneId });
      spoken += said;
      written.push(word);
    });
  }
  return { written: written.join(" "), spoken, tokens };
}

/** Narração contínua do criativo: as falas das cenas, na ordem, normalizadas. */
export function buildNarrationScript(plan: Pick<CreativePlan, "scenes">): NarrationScript {
  return buildScript(plan.scenes.map((s) => ({ sceneId: s.id, text: s.narration })));
}

/** Caracteres que o TTS vai cobrar (texto falado). Usado na estimativa de custo. */
export function spokenNarrationCharacters(plan: Pick<CreativePlan, "scenes">): number {
  return buildNarrationScript(plan).spoken.length;
}
