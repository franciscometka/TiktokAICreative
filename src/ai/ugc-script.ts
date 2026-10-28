import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { PRESENTER_POLICY } from "@/config/edit-policy";
const PRESENTER_WORDS = PRESENTER_POLICY.words;
import type { ScenePlanDraft } from "@/domain/creative";
import { wordWindow, type DurationTarget } from "@/config/duration-targets";
import { identityStrategyOf, isUgcPersonSource, UGC_PERSON_SOURCES, type UgcAudioStrategy, type UgcCharacterIdentity, type UgcProductAnchor } from "@/domain/ugc";

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
  // Lote 5.7: exagero, pressão e falsa urgência.
  { pattern: /voc[êe]\s+precisa\s+(disso|desse|dessa|ter)/i, reason: "pressão de venda (\"você precisa disso\")" },
  { pattern: /\bcorra\b/i, reason: "falsa urgência (\"corra\")" },
  { pattern: /[úu]ltimas\s+unidades|s[óo]\s+hoje|antes\s+que\s+acabe/i, reason: "falsa urgência (\"últimas unidades\")" },
  { pattern: /\b(eu\s+)?uso\s+h[áa]\s+meses\b/i, reason: "experiência pessoal inventada (\"uso há meses\")" },
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
  const allowed = new Set<string>([...UGC_PERSON_SOURCES, "product_broll", "product_image", "text_card", "reference_detail"]);
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
export function buildUgcReferencePrompt(identity: UgcCharacterIdentity, product: UgcProductAnchor, fidelityLines: readonly string[] = []): string {
  // Editor V2: a referência é o PRIMEIRO FRAME real do vídeo, não uma peça de anúncio.
  // Correção Lote 6: avatar salvo com foto = a pessoa É a da foto (nunca uma pessoa sintética nova).
  const avatarPhoto = identityStrategyOf(identity) === "avatar_reference_image";
  return [
    `Candid UGC smartphone photo, vertical 9:16, ${identity.visualStyle.replace(/_/g, " ")} look, natural domestic light, natural skin texture.`,
    avatarPhoto
      ? `The person is exactly the presenter from the supplied avatar photo (same face, facial features, skin tone, hair and apparent age); ${identity.appearance}, wearing a ${identity.wardrobe}, in a ${identity.environmentDescription}.`
      : `${identity.appearance}, wearing a ${identity.wardrobe}, in a ${identity.environmentDescription}.`,
    `The person holds the product from the product photo at chest height in the right hand, relaxed and natural, looking at the camera; framed like a real video frame, not a posed ad.`,
    `The original product photo is the single source of truth for the product: keep ${product.preserve.join(", ")}.`,
    ...fidelityLines,
    `Product name for context only (do not print it as new text): ${product.name}.`,
    avatarPhoto ? `Adult person, not a celebrity; do not replace the avatar with a different person.` : `Fictional synthetic adult person, not a celebrity.`,
    `No text overlays, no slogans, no captions, no invented numbers or specifications, no changed or extra logos, no ad layout, no graphic elements, no watermarks.`,
  ].join(" ");
}

/** Ação/movimento padrão de cada papel da cena UGC (texto curto mostrado no storyboard). */
export const UGC_ROLE_ACTIONS: Record<(typeof UGC_PERSON_SOURCES)[number], string> = {
  ugc_hook: "Segura o produto perto do rosto e fala direto para a câmera",
  ugc_demo: "Gira o produto nas mãos mostrando formato e detalhes",
  ugc_benefit: "Aponta um detalhe do produto enquanto explica",
  ugc_cta: "Mostra o produto para a câmera e faz a chamada final",
};

/**
 * Presenter Only (Lote 5.7): roteiro completo de 5–6 trechos da apresentadora, ~75–95 palavras
 * para 32–40s (tolerância de ±10 para não desperdiçar uma tentativa paga por uma palavra).
 */
export function validatePresenterScript(scenes: readonly Pick<ScenePlanDraft, "visualSource" | "narration">[], target?: DurationTarget): string[] {
  const issues: string[] = [];
  const presenter = scenes.filter((s) => isUgcPersonSource(s.visualSource));
  // Lote 6: com duração escolhida (30/45/60s), trechos = alvo ±1 e palavras pela janela da duração.
  const clips = target ? { min: Math.max(4, target.clips - 1), max: target.clips + 1 } : { min: 5, max: 6 };
  if (presenter.length < clips.min || presenter.length > clips.max) issues.push(`Presenter Only planeja ${clips.min} a ${clips.max} trechos da apresentadora (recebido ${presenter.length}).`);
  const words = countWords(presenter.map((s) => s.narration).join(" "));
  const window = target ? wordWindow(target) : { min: PRESENTER_WORDS.min - 10, max: PRESENTER_WORDS.max + 10 };
  if (!target && (words < window.min || words > window.max)) issues.push(`Roteiro com ${words} palavras; o alvo é ${PRESENTER_WORDS.min}–${PRESENTER_WORDS.max} para 32–40s.`);
  if (presenter[presenter.length - 1]?.visualSource !== "ugc_cta") issues.push("O último trecho é o fechamento com CTA falado (ugc_cta).");
  return issues;
}
