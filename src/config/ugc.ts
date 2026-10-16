import type { ProductInput } from "@/domain/product";
import type { PresetQuality } from "./quality-presets";
import {
  UgcCharacterIdentitySchema,
  type UgcCharacterIdentity,
  type UgcEnvironment,
  type UgcPersonSource,
  type UgcProductAnchor,
  type UgcRequest,
} from "@/domain/ugc";

/**
 * Configuração do AI UGC (Lote 5.3). Sem nichos fixos: ambientes e aparências são genéricos e o
 * sistema funciona para qualquer produto. Escolhas "auto" são DETERMINÍSTICAS (mesmo produto →
 * mesma pessoa/ambiente), para a prévia não mudar a cada visita.
 */

export const UGC_ENVIRONMENT_LABELS: Record<UgcEnvironment, { label: string; description: string }> = {
  kitchen: { label: "Cozinha", description: "bright home kitchen with a clean countertop, natural window light" },
  living_room: { label: "Sala", description: "cozy living room with a sofa and soft daylight" },
  bedroom: { label: "Quarto", description: "tidy bedroom with neutral bedding and warm light" },
  bathroom: { label: "Banheiro", description: "clean bathroom with a mirror and soft white light" },
  home_office: { label: "Home office", description: "home office desk with a laptop and plants, daylight" },
  outdoor: { label: "Ao ar livre", description: "outdoor sidewalk or park on a sunny day, natural light" },
  studio: { label: "Fundo neutro", description: "simple neutral studio background with soft even light" },
  workshop: { label: "Oficina / garagem", description: "organized home workshop or garage with tools on the wall" },
};

/** Palavras do produto → ambiente sugerido. Fallback: sala (genérico). */
const ENVIRONMENT_HINTS: readonly { env: UgcEnvironment; words: readonly string[] }[] = [
  { env: "kitchen", words: ["cozinha", "panela", "garrafa", "copo", "caneca", "faca", "airfryer", "liquidificador", "térmica", "termica", "pote"] },
  { env: "bathroom", words: ["banheiro", "skincare", "creme", "shampoo", "sérum", "serum", "escova", "maquiagem", "perfume"] },
  { env: "home_office", words: ["notebook", "teclado", "mouse", "fone", "celular", "carregador", "mesa", "cadeira", "monitor", "cabo"] },
  { env: "workshop", words: ["ferramenta", "furadeira", "chave", "parafusadeira", "alicate", "martelo", "trena", "serra"] },
  { env: "outdoor", words: ["mochila", "tênis", "tenis", "bicicleta", "garrafa esportiva", "camping", "academia", "corrida"] },
  { env: "bedroom", words: ["travesseiro", "lençol", "lencol", "pijama", "luminária", "luminaria", "cobertor"] },
];

export function suggestEnvironment(product: Pick<ProductInput, "name" | "description">): UgcEnvironment {
  const text = `${product.name} ${product.description}`.toLowerCase();
  return ENVIRONMENT_HINTS.find((h) => h.words.some((w) => text.includes(w)))?.env ?? "living_room";
}

const APPEARANCES = {
  woman: [
    "Brazilian woman in her late 20s, shoulder-length dark wavy hair, warm friendly expression, natural makeup",
    "Brazilian woman in her early 30s, long straight brown hair tied back, relaxed confident smile",
    "Brazilian woman in her 30s, short curly hair, expressive and approachable",
  ],
  man: [
    "Brazilian man in his late 20s, short dark hair, light stubble, friendly relaxed expression",
    "Brazilian man in his early 30s, short curly hair, clean-shaven, approachable smile",
    "Brazilian man in his 30s, short straight hair, trimmed beard, calm confident look",
  ],
} as const;
const WARDROBES = ["plain white t-shirt", "light grey crew-neck sweater", "navy blue casual shirt", "beige linen shirt"] as const;

/** Hash FNV-1a (puro, sem node:crypto: este arquivo também é usado no browser). */
function pick<T>(list: readonly T[], seed: string): T {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return list[h % list.length]!;
}

/** Identidade estável do personagem a partir das escolhas do usuário (ou "auto"). */
export function resolveUgcIdentity(input: {
  id: string;
  revision: number;
  product: Pick<ProductInput, "id" | "name" | "description">;
  request: UgcRequest;
}): UgcCharacterIdentity {
  const seed = `${input.product.id}:${input.revision}`;
  const gender = input.request.presenter === "auto" ? pick(["woman", "man"] as const, `${seed}:gender`) : input.request.presenter;
  const environment = input.request.environment === "auto" ? suggestEnvironment(input.product) : input.request.environment;
  const appearance = pick(APPEARANCES[gender], `${seed}:appearance`);
  return UgcCharacterIdentitySchema.parse({
    id: input.id,
    revision: input.revision,
    source: "generated",
    gender,
    ageRange: appearance.includes("20s") ? "20s" : "30s",
    appearance,
    wardrobe: pick(WARDROBES, `${seed}:wardrobe`),
    environment,
    environmentDescription: UGC_ENVIRONMENT_LABELS[environment].description,
    visualStyle: input.request.visualStyle,
    tags: [],
  });
}

/** Produto-âncora: a foto original e o que deve ser preservado na pessoa+produto. */
export function productAnchor(product: ProductInput): UgcProductAnchor | undefined {
  const image = product.images[0];
  if (!image) return undefined;
  return {
    imageId: image.id,
    imageUri: image.uri,
    name: product.name,
    description: product.description,
    preserve: ["exact product shape and proportions", "original colors", "logo and printed text", "packaging and label", "real size relative to the hands"],
  };
}

/**
 * Plano de cenas por preset (ordem = ordem no vídeo). Econômico usa menos UGC e mais imagem/
 * B-roll composto no Remotion; Equilibrado é o principal; Premium tem mais UGC e B-roll gerado.
 * `share` = fração da duração final.
 */
export interface UgcScenePlanEntry {
  source: UgcPersonSource | "product_broll" | "product_image";
  share: number;
}

export const UGC_PRESET_PLANS: Record<PresetQuality, readonly UgcScenePlanEntry[]> = {
  economy: [
    { source: "ugc_hook", share: 0.3 },
    { source: "product_image", share: 0.4 },
    { source: "ugc_cta", share: 0.3 },
  ],
  high: [
    { source: "ugc_hook", share: 0.22 },
    { source: "ugc_benefit", share: 0.26 },
    { source: "product_broll", share: 0.18 },
    { source: "product_image", share: 0.14 },
    { source: "ugc_cta", share: 0.2 },
  ],
  premium: [
    { source: "ugc_hook", share: 0.16 },
    { source: "ugc_demo", share: 0.18 },
    { source: "product_broll", share: 0.14 },
    { source: "ugc_benefit", share: 0.18 },
    { source: "product_broll", share: 0.14 },
    { source: "ugc_cta", share: 0.2 },
  ],
};

/** Ritmo máximo de fala natural (palavras/s) usado para validar o roteiro UGC. */
export const UGC_MAX_WORDS_PER_SECOND = 2.8;
