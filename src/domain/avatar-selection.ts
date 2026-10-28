import { normalizeTags, type Avatar, type AvatarSelection } from "./avatar";

/**
 * Escolha AUTOMÁTICA do apresentador (Lote 6). Pura e determinística:
 *   produto → tags/categorias (da análise do Claude, quando houver, ou do próprio texto do produto)
 *   → avatares ATIVOS compatíveis → melhor pontuação → motivo registrado.
 * Sem avatar compatível: geração sintética (identidade "generated" existente).
 * Nada de nicho fixo: só as tags que o próprio usuário criou nos avatares contam.
 */

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Tags do usuário que aparecem no texto do produto (palavra inteira, sem acento). */
export function inferProductTags(product: { name: string; description: string; features?: readonly string[]; benefits?: readonly string[] }, knownTags: readonly string[]): string[] {
  const haystack = ` ${strip([product.name, product.description, ...(product.features ?? []), ...(product.benefits ?? [])].join(" ")).replace(/[^a-z0-9]+/g, " ")} `;
  return normalizeTags(knownTags).filter((tag) => {
    const needle = strip(tag).replace(/[^a-z0-9]+/g, " ").trim();
    if (!needle) return false;
    // "cabelo" casa "cabelos"; "ferramenta" casa "ferramentas".
    return haystack.includes(` ${needle} `) || haystack.includes(` ${needle}s `) || haystack.includes(` ${needle}es `);
  });
}

export interface AvatarScore {
  avatar: Avatar;
  score: number;
  matchedTags: string[];
}

/** defaultForTags vale mais que preferredProductCategories, que vale mais que tags descritivas. */
export function scoreAvatar(avatar: Avatar, productTags: readonly string[]): AvatarScore {
  const wanted = new Set(normalizeTags(productTags));
  const matched = new Set<string>();
  let score = 0;
  for (const tag of avatar.defaultForTags) if (wanted.has(tag)) { score += 5; matched.add(tag); }
  for (const tag of avatar.preferredProductCategories) if (wanted.has(tag)) { score += 3; matched.add(tag); }
  for (const tag of avatar.tags) if (wanted.has(tag)) { score += 1; matched.add(tag); }
  return { avatar, score, matchedTags: [...matched] };
}

export function selectAvatar(
  avatars: readonly Avatar[],
  product: { name: string; description: string; features?: readonly string[]; benefits?: readonly string[] },
  options: { productTags?: readonly string[] } = {},
): AvatarSelection {
  const candidates = avatars.filter((a) => a.active && !a.archived);
  const known = candidates.flatMap((a) => [...a.tags, ...a.preferredProductCategories, ...a.defaultForTags]);
  const productTags = normalizeTags([...(options.productTags ?? []), ...inferProductTags(product, known)]);
  const ranked = candidates
    .map((avatar) => scoreAvatar(avatar, productTags))
    .filter((s) => s.score > 0)
    // Empate: o mais recentemente atualizado, depois o id (determinístico).
    .sort((a, b) => b.score - a.score || b.avatar.updatedAt.localeCompare(a.avatar.updatedAt) || a.avatar.id.localeCompare(b.avatar.id));
  const best = ranked[0];
  if (!best) {
    return {
      mode: "synthetic",
      reason: candidates.length === 0
        ? "Nenhum avatar ativo na biblioteca: apresentadora sintética gerada automaticamente."
        : `Nenhum avatar ativo combina com o produto${productTags.length ? ` (${productTags.join(", ")})` : ""}: apresentadora sintética gerada automaticamente.`,
      matchedTags: [],
    };
  }
  const isDefault = best.avatar.defaultForTags.some((t) => best.matchedTags.includes(t));
  return {
    mode: "auto",
    avatarId: best.avatar.id,
    avatarRevision: best.avatar.revision,
    reason: `${best.avatar.name} escolhido automaticamente: ${isDefault ? "padrão para" : "combina com"} ${best.matchedTags.join(", ")}.`,
    matchedTags: best.matchedTags,
  };
}
