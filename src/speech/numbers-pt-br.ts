/**
 * Números por extenso em português do Brasil (inteiros de 0 a 999.999.999).
 * `feminine` muda "um/dois" e as centenas ("duas horas", "duzentas peças").
 */

const UNITS_M = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const UNITS_F = ["zero", "uma", "duas", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const TEENS = ["dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS_M = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const HUNDREDS_F = ["", "cento", "duzentas", "trezentas", "quatrocentas", "quinhentas", "seiscentas", "setecentas", "oitocentas", "novecentas"];

function below100(n: number, feminine: boolean): string {
  const units = feminine ? UNITS_F : UNITS_M;
  if (n < 10) return units[n] ?? "";
  if (n < 20) return TEENS[n - 10] ?? "";
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? (TENS[t] ?? "") : `${TENS[t]} e ${units[u]}`;
}

function below1000(n: number, feminine: boolean): string {
  if (n === 100) return "cem";
  if (n < 100) return below100(n, feminine);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = (feminine ? HUNDREDS_F : HUNDREDS_M)[h] ?? "";
  return rest === 0 ? head : `${head} e ${below100(rest, feminine)}`;
}

/** Junta grupos: "e" antes do último grupo quando ele é < 100 ou centena redonda. */
function joinGroups(parts: { text: string; value: number }[]): string {
  return parts
    .map((p, i) => {
      if (i === 0) return p.text;
      const last = i === parts.length - 1;
      const useE = last && (p.value < 100 || p.value % 100 === 0);
      return `${useE ? "e " : ""}${p.text}`;
    })
    .join(" ");
}

export function numberToWordsPtBr(value: number, options: { feminine?: boolean } = {}): string {
  if (!Number.isInteger(value) || value < 0 || value > 999_999_999) {
    throw new RangeError(`Número fora do suportado: ${value}`);
  }
  const feminine = options.feminine ?? false;
  if (value === 0) return "zero";
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1000);
  const rest = value % 1000;
  const parts: { text: string; value: number }[] = [];
  if (millions > 0) parts.push({ text: `${below1000(millions, false)} ${millions === 1 ? "milhão" : "milhões"}`, value: millions * 1000 });
  if (thousands > 0) parts.push({ text: thousands === 1 ? "mil" : `${below1000(thousands, feminine)} mil`, value: thousands * 1000 });
  if (rest > 0) parts.push({ text: below1000(rest, feminine), value: rest });
  return joinGroups(parts);
}

/** "R$ 79,90" → "setenta e nove reais e noventa centavos". */
export function currencyToWordsPtBr(reais: number, centavos: number): string {
  const r = reais > 0 ? `${numberToWordsPtBr(reais)} ${reais === 1 ? "real" : "reais"}` : "";
  const c = centavos > 0 ? `${numberToWordsPtBr(centavos)} ${centavos === 1 ? "centavo" : "centavos"}` : "";
  if (r && c) return `${r} e ${c}`;
  return r || c || "zero reais";
}
