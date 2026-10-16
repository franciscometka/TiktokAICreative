export interface ProductEnrichment {
  description: string;
  features: string[];
  benefits: string[];
  audience: string;
}

/** Estrutura somente o texto fornecido. Não acrescenta medidas, desempenho ou claims. */
export function enrichProductLocally(input: { name: string; description: string }): ProductEnrichment {
  const name = input.name.trim();
  const source = input.description.trim();
  const facts = source
    .split(/[.;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 6);
  return {
    description: source || `${name || "Produto"} — adicione detalhes confirmados para enriquecer o roteiro.`,
    features: facts,
    benefits: [],
    audience: name ? `Pessoas interessadas em ${name.toLocaleLowerCase("pt-BR")}` : "",
  };
}
