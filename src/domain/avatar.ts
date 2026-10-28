import { z } from "zod";
import { UgcEnvironmentSchema } from "./ugc";

/**
 * Lote 6 — Biblioteca de avatares. Avatar = apresentador REUTILIZÁVEL com identidade visual e voz
 * próprias. Identidade visual (rosto, cabelo, roupa, ambiente) e voz (VoiceProfile) são separadas.
 * Tags são LIVRES (criadas pelo usuário); nenhum nicho fixo no código.
 * Toda mudança de identidade gera nova `revision`; jobs guardam a revisão que usaram.
 */

const nonEmpty = z.string().trim().min(1);
const text = (max: number) => z.string().trim().max(max);

export const SAFE_AVATAR_ID = /^avatar_[A-Za-z0-9_-]{1,56}$/;
export const SAFE_VOICE_PROFILE_ID = /^voice_[A-Za-z0-9_-]{1,56}$/;

/** "Beleza", " cabelo " → "beleza", "cabelo"; sem duplicatas; no máximo 20. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 20);
}

const TagListSchema = z.array(z.string()).max(40).transform(normalizeTags);

/**
 * Perfil de voz. `providerVoiceId` é dado de SERVIDOR: nunca vai ao browser nem a logs
 * (o view model público omite o campo). Perfis embutidos apontam para um SpeakerProfile
 * (config/voices.ts), que resolve o voiceId só dentro do provider.
 */
export const VoiceProfileSchema = z.object({
  id: z.string().regex(SAFE_VOICE_PROFILE_ID),
  provider: z.enum(["elevenlabs"]),
  /** Perfil base (config/voices.ts) usado pela narração. */
  speakerProfileId: nonEmpty,
  providerVoiceId: z.string().trim().max(200).optional(),
  name: nonEmpty.max(60),
  language: z.string().default("pt"),
  locale: z.string().default("pt-BR"),
  style: text(120).default(""),
  stability: z.number().min(0).max(1).default(0.5),
  speed: z.number().min(0.7).max(1.2).default(1),
  similarity: z.number().min(0).max(1).default(0.75),
  enabled: z.boolean().default(true),
  builtIn: z.boolean().default(false),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/** Campos que definem a IDENTIDADE visual: mudar qualquer um cria nova revisão. */
export const AVATAR_IDENTITY_FIELDS = [
  "referenceImage", "gender", "appearanceDescriptors", "visualAgeRange", "hair", "appearancePrompt", "defaultOutfit", "defaultEnvironment", "environment",
] as const;

export const AvatarReferenceImageSchema = z.object({
  /** Pasta de upload (mesmo formato de SAFE_PRODUCT_ID) e nome gerado pelo servidor. */
  ownerId: nonEmpty,
  imageId: nonEmpty,
  uri: nonEmpty,
});

export const AvatarSchema = z.object({
  id: z.string().regex(SAFE_AVATAR_ID),
  revision: z.int().positive(),
  name: nonEmpty.max(60),
  active: z.boolean().default(true),
  referenceImage: AvatarReferenceImageSchema.optional(),
  gender: z.enum(["woman", "man"]),
  appearanceDescriptors: text(300).default(""),
  visualAgeRange: z.enum(["20s", "30s", "40s"]).default("30s"),
  hair: text(160).default(""),
  /** Prompt-base opcional (configurações avançadas). */
  appearancePrompt: text(600).default(""),
  defaultOutfit: text(160).default(""),
  /** Ambiente padrão em texto livre ("quarto moderno"). */
  defaultEnvironment: text(160).default(""),
  /** Ambiente genérico do motor (opcional): orienta luz/cenário quando o texto é vago. */
  environment: UgcEnvironmentSchema.optional(),
  speakingStyle: text(160).default(""),
  personality: text(160).default(""),
  tags: TagListSchema.default([]),
  preferredProductCategories: TagListSchema.default([]),
  /** "Usar como padrão para": tags (livres) em que este avatar é o preferido. */
  defaultForTags: TagListSchema.default([]),
  voiceProfileId: z.string().regex(SAFE_VOICE_PROFILE_ID).optional(),
  voiceProvider: z.string().optional(),
  voiceName: z.string().optional(),
  voiceSettings: z.object({ stability: z.number(), speed: z.number(), similarity: z.number() }).optional(),
  archived: z.boolean().default(false),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type Avatar = z.infer<typeof AvatarSchema>;

/** Arquivo de um avatar: estado atual + TODAS as revisões (jobs antigos continuam resolvendo). */
export const AvatarRecordSchema = z.object({
  current: AvatarSchema,
  revisions: z.array(AvatarSchema).min(1),
});
export type AvatarRecord = z.infer<typeof AvatarRecordSchema>;

/** Entrada do formulário (criar/editar). */
export const AvatarInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao avatar.").max(60, "Nome com até 60 caracteres."),
  gender: z.enum(["woman", "man"], { message: "Escolha mulher ou homem." }),
  referenceImage: z.object({ ownerId: z.string(), imageId: z.string() }).optional(),
  appearanceDescriptors: text(300).optional(),
  visualAgeRange: z.enum(["20s", "30s", "40s"]).optional(),
  hair: text(160).optional(),
  appearancePrompt: text(600).optional(),
  defaultOutfit: text(160).optional(),
  defaultEnvironment: text(160).optional(),
  environment: UgcEnvironmentSchema.optional(),
  speakingStyle: text(160).optional(),
  personality: text(160).optional(),
  tags: z.array(z.string()).max(40).optional(),
  preferredProductCategories: z.array(z.string()).max(40).optional(),
  defaultForTags: z.array(z.string()).max(40).optional(),
  voiceProfileId: z.string().regex(SAFE_VOICE_PROFILE_ID, "Escolha uma voz da lista.").optional(),
  active: z.boolean().optional(),
});
export type AvatarInput = z.infer<typeof AvatarInputSchema>;

/** Mudou algo da identidade visual? (nome, tags, voz e personalidade não mudam o rosto). */
export function identityChanged(before: Avatar, after: Avatar): boolean {
  return AVATAR_IDENTITY_FIELDS.some((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

/**
 * Snapshot imutável do avatar usado por um job: fica no pedido da campanha. Se o avatar for
 * alterado depois, o job continua com esta revisão.
 */
export const AvatarSnapshotSchema = AvatarSchema.pick({
  id: true, revision: true, name: true, referenceImage: true, gender: true, appearanceDescriptors: true, visualAgeRange: true, hair: true,
  appearancePrompt: true, defaultOutfit: true, defaultEnvironment: true, environment: true, speakingStyle: true, personality: true, tags: true,
  voiceProfileId: true, voiceName: true,
});
export type AvatarSnapshot = z.infer<typeof AvatarSnapshotSchema>;

export function avatarSnapshot(avatar: Avatar): AvatarSnapshot {
  return AvatarSnapshotSchema.parse(avatar);
}

/** Escolha do apresentador registrada no projeto (com o motivo, inclusive no automático). */
export const AvatarSelectionSchema = z.object({
  mode: z.enum(["auto", "manual", "synthetic"]),
  avatarId: z.string().optional(),
  avatarRevision: z.int().positive().optional(),
  reason: nonEmpty,
  matchedTags: z.array(z.string()).default([]),
  snapshot: AvatarSnapshotSchema.optional(),
});
export type AvatarSelection = z.infer<typeof AvatarSelectionSchema>;

/** Descrição física estável para o motor de imagem (nunca uma pessoa real/famosa). */
export function avatarAppearance(avatar: Pick<AvatarSnapshot, "gender" | "visualAgeRange" | "hair" | "appearanceDescriptors" | "appearancePrompt">): string {
  const base = avatar.appearancePrompt.trim();
  if (base) return base;
  const who = avatar.gender === "woman" ? "Brazilian woman" : "Brazilian man";
  const age = { "20s": "in her/his 20s", "30s": "in her/his 30s", "40s": "in her/his 40s" }[avatar.visualAgeRange].replace("her/his", avatar.gender === "woman" ? "her" : "his");
  return [`${who} ${age}`, avatar.hair, avatar.appearanceDescriptors].filter((part) => part.trim()).join(", ");
}
