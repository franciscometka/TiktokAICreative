/**
 * Utilitários monetários. Cálculos internos usam number em USD sem arredondar;
 * arredondamento acontece só na borda (saída de estimativas/registros).
 * Comparações de orçamento usam centavos inteiros para evitar erro de ponto flutuante.
 */

export function toCents(brl: number): number {
  return Math.round(brl * 100);
}

export function roundBrl(value: number): number {
  return Math.round(value * 100) / 100;
}

/** USD com 6 casas: preços por token são frações muito pequenas de centavo. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function usdToBrl(usd: number, exchangeRate: number): number {
  if (!(exchangeRate > 0)) {
    throw new RangeError(`Cotação USD→BRL inválida: ${exchangeRate}`);
  }
  return usd * exchangeRate;
}

const brlFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBrl(value: number): string {
  return brlFormatter.format(value);
}
