import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import type { ScenePlanDraft } from "@/domain/creative";
import { isUgcPersonSource, UGC_PERSON_SOURCES, type UgcAudioStrategy, type UgcCharacterIdentity, type UgcProductAnchor } from "@/domain/ugc";

/**
 * Regras do roteiro AI UGC (puras, usadas pelo prompt, pelo mock e pela validação).
 * Tom de creator do TikTok ("Olha isso aqui…", "Se você procura…", "Esse modelo chama atenção
 * por…"), sem jargão publicitário e SEM experiência inventada (D42).
 */

export const UGC_PREFERRED_OPENERS = ["Olha isso aqui", "Se você procura", "Repara nesse detalhe", "Esse modelo chama atenção por"] as const;

/** Frases proibidas: experiência pessoal/depoimento inventados e jargão de anúncio. */
const FORBIDDEN: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\buso\s+(h[áa]|faz)(?![a-zà-ú])/i, reason: "experiência pessoal inventada (\"uso há…\")" },
  { pattern: /\b(eu\s+)?test(ei|amos)\b/i, reason: "teste pessoal inventado (\"testei\")" },
  { pattern: /funcionou\s+(comigo|pra\s+mim|para\s+mim)/i, reason: "resultado pessoal inventado (\"funcionou comigo\")" },
  { pattern: /\b(eu\s+)?comprei\b/i, reason: "compra pessoal inventada (\"comprei\")" },
  { pattern: /\b(eu\s+)?(amei|uso\s+todo\s+dia|uso\s+sempre)\b/i, reason: "depoimento pessoal inventado" },
  { pattern: /\bminha\s+experi[êe]ncia\b/i, reason: "experiência pessoal inventada" },
  { pattern: /\b(depoimento|meus?\s+clientes?\s+(amaram|aprovaram))\b/i, reason: "depoimento/prova social inventados" },
  { pattern: /conhe[çc]a\s+(este|esse)\s+(incr[íi]vel|maravilhoso)/i, reason: "jargão publicitário (\"Conheça este incrível…\")" },
  { pattern: /\b(revolucion[áa]rio|imperd[íi]vel|incr[íi]vel\s+produto)\b/i, reason: "jargão publicitário" },
];

export function findUgcSpeechViolations(text: string): string[] {
  return FORBIDDEN.filter((f) => f.pattern.test(text)).map((f) => f.reason);
}

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** A fala cabe na duração da cena com ritmo natural? */
export function speechFitsDuration(text: string, durationSeconds: number): boolean {
  return countWords(text) <= Math.floor(durationSeconds * UGC_MAX_WORDS_PER_SECOND);
}

export interface UgcPlanIssue {
  sceneIndex: number | null;
  message: string;
}

/** Valida as cenas de um criativo AI UGC (estrutura, fala natural, duração, estratégia de áudio). */
export function validateUgcScenes(scenes: readonly ScenePlanDraft[], audioStrategy: UgcAudioStrategy): UgcPlanIssue[] {
  const issues: UgcPlanIssue[] = [];
  const allowed = new Set<string>([...UGC_PERSON_SOURCES, "product_broll", "product_image", "text_card"]);
  if (scenes[0]?.visualSource !== "ugc_hook") issues.push({ sceneIndex: 0, message: "A primeira cena do AI UGC deve ser ugc_hook (pessoa + produto falando para a câmera)." });
  if (!scenes.some((s) => s.visualSource === "ugc_cta")) issues.push({ sceneIndex: null, message: "O AI UGC precisa de uma cena ugc_cta (mesma pessoa + produto + chamada final)." });
  scenes.forEach((scene, i) => {
    if (!allowed.has(scene.visualSource)) issues.push({ sceneIndex: i, message: `Tipo de cena "${scene.visualSource}" não é usado no AI UGC.` });
    for (const reason of findUgcSpeechViolations(scene.narration)) issues.push({ sceneIndex: i, message: `Fala proibida: ${reason}.` });
    if (!speechFitsDuration(scene.narration, scene.duration)) {
      issues.push({ sceneIndex: i, message: `Fala longa demais para ${scene.duration}s (máx. ${Math.floor(scene.duration * UGC_MAX_WORDS_PER_SECOND)} palavras).` });
    }
    if (isUgcPersonSource(scene.visualSource) && !scene.narration.trim()) issues.push({ sceneIndex: i, message: "Cena UGC precisa de fala para a câmera." });
    // Estratégia A (fala nativa do vídeo): não existe narração separada para B-roll/imagens.
    if (audioStrategy === "native_speech" && !isUgcPersonSource(scene.visualSource) && scene.narration.trim()) {
      issues.push({ sceneIndex: i, message: "Com fala nativa do vídeo, só as cenas UGC têm fala; B-roll e imagens ficam sem narração." });
    }
  });
  return issues;
}

/** Prompt da imagem de REFERÊNCIA: pessoa realista segurando o produto real, 9:16, sem distorcer o produto. */
export function buildUgcReferencePrompt(identity: UgcCharacterIdentity, product: UgcProductAnchor): string {
  return [
    `Vertical 9:16 smartphone photo, ${identity.visualStyle.replace(/_/g, " ")} look.`,
    `${identity.appearance}, wearing a ${identity.wardrobe}, in a ${identity.environmentDescription}.`,
    `The person holds the product from the reference image at chest height, naturally, looking at the camera.`,
    `The product is exactly the one in the reference photo: keep ${product.preserve.join(", ")}.`,
    `Product: ${product.name}.`,
    `Fictional adult person, not a celebrity. No text overlays, no extra logos, no watermarks.`,
  ].join(" ");
}

/** Ação/movimento padrão de cada papel da cena UGC (texto curto mostrado no storyboard). */
export const UGC_ROLE_ACTIONS: Record<(typeof UGC_PERSON_SOURCES)[number], string> = {
  ugc_hook: "Segura o produto perto do rosto e fala direto para a câmera",
  ugc_demo: "Gira o produto nas mãos mostrando formato e detalhes",
  ugc_benefit: "Aponta um detalhe do produto enquanto explica",
  ugc_cta: "Mostra o produto para a câmera e faz a chamada final",
};
