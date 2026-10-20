/**
 * Lote 6 — Style guide do UGC brasileiro. Usado pelo prompt (texto) e pela validação (padrões).
 * Objetivo: soar como uma pessoa real falando no TikTok, não como comercial de TV.
 */

export const UGC_BR_STYLE_GUIDE = `
# Style guide — UGC brasileiro natural
- Fale como uma pessoa real gravando com o celular: frases curtas, ritmo de conversa, transições naturais ("olha", "repara", "e o melhor", "aqui do lado").
- Use detalhes REAIS do produto (os fornecidos), do jeito que alguém comentaria em voz alta.
- Uma ideia por frase. Nada de listas de adjetivos ("lindo, moderno, prático e incrível").
- Não repita a mesma palavra de efeito nem a mesma estrutura de frase.
- Proibido: linguagem corporativa, tom de comercial de TV, "produto revolucionário", "você precisa disso", "imperdível", "corra", "últimas unidades", "garantido", "o melhor do mercado", depoimento ou experiência inventada ("uso há meses", "testei", "comprei").
- O CTA é a ÚLTIMA frase do roteiro, leve e adaptado ao produto. Estilo: "Se você curtiu esse modelo, dá uma olhada no carrinho e confere os detalhes."
- Depois da última palavra a pessoa continua em cena por cerca de 1 segundo, sem falar.`;

/** Padrões de estilo que bloqueiam o roteiro (somam-se às proibições de experiência inventada). */
export const STYLE_BLOCKERS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgarantid[oa]s?\b/i, reason: "promessa de garantia (\"garantido\")" },
  { pattern: /o\s+melhor\s+do\s+mercado/i, reason: "superlativo sem prova (\"o melhor do mercado\")" },
  { pattern: /voc[êe]\s+n[ãa]o\s+vai\s+acreditar/i, reason: "clickbait (\"você não vai acreditar\")" },
  { pattern: /[!?]{2,}/, reason: "pontuação exagerada (\"!!\")" },
  { pattern: /\b(aproveite\s+j[áa]|compre\s+agora|n[ãa]o\s+perca)\b/i, reason: "chamada agressiva de comercial" },
];

/** Avisos (não pedem nova chamada paga): excesso de adjetivos e repetição. */
const ADJECTIVES = /\b(incr[íi]vel|maravilhos[oa]|perfeit[oa]|lind[oa]|sensacional|espetacular|fant[áa]stic[oa]|maravilha|top)\b/gi;

export function styleWarnings(text: string): string[] {
  const warnings: string[] = [];
  const adjectives = text.match(ADJECTIVES) ?? [];
  if (adjectives.length > 2) warnings.push(`Muitos adjetivos de efeito (${adjectives.length}): prefira detalhes reais do produto.`);
  const words = text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const repeated = [...counts].filter(([w, n]) => n >= 4 && !["esse", "essa", "isso", "aqui", "para", "você", "voce", "pra", "como", "mais", "dele", "dela", "modelo"].includes(w)).map(([w]) => w);
  if (repeated.length > 0) warnings.push(`Palavras repetidas demais: ${repeated.slice(0, 3).join(", ")}.`);
  return warnings;
}

/** O fechamento soa como CTA natural (carrinho/link/conferir), sem pressão? */
export const NATURAL_CTA = /(carrinho|link|confer[ea]|d[áa]\s+uma\s+olhada|olha\s+os\s+detalhes|clica|toca)/i;
