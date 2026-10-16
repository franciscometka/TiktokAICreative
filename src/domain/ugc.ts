import { z } from "zod";
import { ProviderDiagnosticSchema } from "./provider-diagnostic";

/**
 * AI UGC (Lote 5.3): pessoa realista SEGURANDO/APRESENTANDO o produto real, falando para a câmera.
 * Separado do Presenter (avatar dirigido por áudio, D74): aqui a pessoa e o produto nascem juntos
 * numa imagem de REFERÊNCIA aprovada pelo usuário, e todas as cenas UGC partem dela.
 * Nada aqui conhece um provider específico.
 */

const nonEmpty = z.string().trim().min(1);

/** Cenas com a pessoa (geradas pelo UGCVideoProvider a partir da referência aprovada). */
export const UGC_PERSON_SOURCES = ["ugc_hook", "ugc_demo", "ugc_benefit", "ugc_cta"] as const;
/** Cena complementar: close cinematográfico do produto (VideoProvider genérico). */
export const UGC_BROLL_SOURCE = "product_broll" as const;
export type UgcPersonSource = (typeof UGC_PERSON_SOURCES)[number];
export function isUgcPersonSource(source: string): source is UgcPersonSource {
  return (UGC_PERSON_SOURCES as readonly string[]).includes(source);
}

export const CREATIVE_MODES = ["standard", "ai_ugc"] as const;
export const CreativeModeSchema = z.enum(CREATIVE_MODES);
export type CreativeMode = z.infer<typeof CreativeModeSchema>;

export const UgcPresenterChoiceSchema = z.enum(["auto", "woman", "man"]);
export type UgcPresenterChoice = z.infer<typeof UgcPresenterChoiceSchema>;

/** Ambientes genéricos (sem nichos fixos). "auto" é resolvido a partir do produto. */
export const UGC_ENVIRONMENTS = ["kitchen", "living_room", "bedroom", "bathroom", "home_office", "outdoor", "studio", "workshop"] as const;
export const UgcEnvironmentSchema = z.enum(UGC_ENVIRONMENTS);
export type UgcEnvironment = z.infer<typeof UgcEnvironmentSchema>;
export const UgcEnvironmentChoiceSchema = z.union([z.literal("auto"), UgcEnvironmentSchema]);
export type UgcEnvironmentChoice = z.infer<typeof UgcEnvironmentChoiceSchema>;

export const UGC_VISUAL_STYLES = ["natural_smartphone", "bright_clean", "warm_cozy"] as const;
export const UgcVisualStyleSchema = z.enum(UGC_VISUAL_STYLES);
export type UgcVisualStyle = z.infer<typeof UgcVisualStyleSchema>;

/**
 * A) native_speech: o modelo de vídeo gera fala + áudio; não há TTS separado para as cenas UGC.
 * B) external_lipsync: ElevenLabs gera a narração; o modelo sincroniza os lábios com o trecho.
 * Cada UGCVideoProvider DECLARA a sua; o job guarda a escolhida no planejamento.
 */
export const UgcAudioStrategySchema = z.enum(["native_speech", "external_lipsync"]);
export type UgcAudioStrategy = z.infer<typeof UgcAudioStrategySchema>;

/** Escolhas do usuário no fluxo simples. */
export const UgcRequestSchema = z.object({
  presenter: UgcPresenterChoiceSchema.default("auto"),
  environment: UgcEnvironmentChoiceSchema.default("auto"),
  visualStyle: UgcVisualStyleSchema.default("natural_smartphone"),
  /** Preenchido pelo sistema no planejamento a partir do UGCVideoProvider escolhido. */
  audioStrategy: UgcAudioStrategySchema.optional(),
});
export type UgcRequest = z.infer<typeof UgcRequestSchema>;

/**
 * Identidade do personagem persistida no job: TODAS as cenas UGC carregam a mesma pessoa, roupa,
 * ambiente e produto. `source: "library"` + `libraryCharacterId` ficam prontos para uma futura
 * biblioteca de personagens reutilizáveis; `tags` são livres (sem nichos fixos).
 */
export const UgcCharacterIdentitySchema = z.object({
  id: nonEmpty,
  revision: z.int().positive(),
  source: z.enum(["generated", "library"]),
  libraryCharacterId: z.string().optional(),
  gender: z.enum(["woman", "man"]),
  ageRange: z.enum(["20s", "30s", "40s"]),
  /** Descrição física estável (cabelo, traços gerais) — nunca uma pessoa real/famosa. */
  appearance: nonEmpty,
  wardrobe: nonEmpty,
  environment: UgcEnvironmentSchema,
  environmentDescription: nonEmpty,
  visualStyle: UgcVisualStyleSchema,
  tags: z.array(z.string().trim().min(1)).max(10).default([]),
});
export type UgcCharacterIdentity = z.infer<typeof UgcCharacterIdentitySchema>;

/** Estrutura para a FUTURA biblioteca de personagens (sem nichos definidos agora). */
export const UgcCharacterProfileSchema = z.object({
  id: nonEmpty,
  displayName: nonEmpty,
  gender: z.enum(["woman", "man"]),
  ageRange: z.enum(["20s", "30s", "40s"]),
  appearance: nonEmpty,
  defaultWardrobe: nonEmpty,
  defaultEnvironment: UgcEnvironmentSchema.optional(),
  /** Rótulos livres (ex.: "fitness", "casa") definidos pelo usuário no futuro. */
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  /** Imagem da pessoa SEM produto, com consentimento quando for pessoa real. */
  portraitUri: z.string().optional(),
  imageConsent: z.boolean().default(false),
  createdAt: nonEmpty,
});
export type UgcCharacterProfile = z.infer<typeof UgcCharacterProfileSchema>;

/** O produto como deve aparecer: foto original + descrição estruturada do que preservar. */
export const UgcProductAnchorSchema = z.object({
  imageId: nonEmpty,
  imageUri: nonEmpty,
  name: nonEmpty,
  description: z.string(),
  /** O que NUNCA muda: cor, formato, logo, embalagem, proporções. */
  preserve: z.array(nonEmpty).min(1),
});
export type UgcProductAnchor = z.infer<typeof UgcProductAnchorSchema>;

/** Uma imagem de referência (pessoa + produto). Versionada; toda geração custa e fica registrada. */
export const UgcReferenceSchema = z.object({
  id: nonEmpty,
  version: z.string().regex(/^v[1-9]\d{0,3}$/),
  /** submitting = intenção persistida ANTES do envio; sem ID nunca é reenviada. */
  state: z.enum(["submitting", "pending", "succeeded", "failed"]),
  review: z.enum(["pending", "approved", "rejected"]),
  identityId: nonEmpty,
  identityRevision: z.int().positive(),
  provider: nonEmpty,
  model: nonEmpty,
  isMock: z.boolean(),
  providerJobId: z.string().optional(),
  /** URI relativa (real) ou mock://. Nunca URL temporária do provider. */
  imageUri: z.string().optional(),
  prompt: nonEmpty,
  product: UgcProductAnchorSchema,
  estimatedCostUsd: z.number().nonnegative(),
  actualCostUsd: z.number().nonnegative().optional(),
  error: z.string().optional(),
  diagnostic: ProviderDiagnosticSchema.optional(),
  createdAt: nonEmpty,
  reviewedAt: z.string().optional(),
});
export type UgcReference = z.infer<typeof UgcReferenceSchema>;

export const UgcJobStateSchema = z.object({
  identity: UgcCharacterIdentitySchema,
  audioStrategy: UgcAudioStrategySchema,
  product: UgcProductAnchorSchema,
  references: z.array(UgcReferenceSchema).default([]),
});
export type UgcJobState = z.infer<typeof UgcJobStateSchema>;

/** Gravado em cada tentativa de cena UGC: prova de consistência (mesma pessoa/referência/produto). */
export const UgcSceneConsistencySchema = z.object({
  role: z.enum(UGC_PERSON_SOURCES),
  referenceId: nonEmpty,
  referenceVersion: nonEmpty,
  identityId: nonEmpty,
  identityRevision: z.int().positive(),
  wardrobe: nonEmpty,
  environment: UgcEnvironmentSchema,
  productImageId: nonEmpty,
  audioStrategy: UgcAudioStrategySchema,
  /** true = o clipe traz a fala (native_speech); o render usa o áudio do clipe e nenhuma narração. */
  clipHasAudio: z.boolean(),
  speech: z.string(),
  action: z.string(),
});
export type UgcSceneConsistency = z.infer<typeof UgcSceneConsistencySchema>;

export function approvedReference(state: UgcJobState | undefined): UgcReference | undefined {
  return state?.references.findLast(
    (r) => r.review === "approved" && r.state === "succeeded" && r.identityId === state.identity.id && r.identityRevision === state.identity.revision,
  );
}

export function latestReference(state: UgcJobState | undefined): UgcReference | undefined {
  return state?.references[state.references.length - 1];
}
