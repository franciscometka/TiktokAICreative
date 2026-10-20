import { z } from "zod";

/**
 * Lote 6 — Roteiro mestre. O vídeo nasce de UM texto contínuo (hook → corpo → demonstração →
 * fechamento → CTA), validado e só DEPOIS dividido em segmentos de fala, um por A-roll.
 * Todos os segmentos herdam a MESMA persona (vocabulário, tom, ritmo, intenção): nada de
 * mini-roteiros independentes por trecho. O CTA é a última frase do próprio roteiro.
 */

export const ScriptPersonaSchema = z.object({
  personaId: z.string().min(1),
  avatarId: z.string().optional(),
  avatarName: z.string().optional(),
  tone: z.string().min(1),
  speakingStyle: z.string().min(1),
  pace: z.enum(["calm", "natural", "lively"]),
  vocabulary: z.literal("conversational_pt_br"),
});
export type ScriptPersona = z.infer<typeof ScriptPersonaSchema>;

export const MasterScriptSegmentSchema = z.object({
  index: z.int().nonnegative(),
  sceneId: z.string().optional(),
  text: z.string().min(1),
  wordCount: z.int().positive(),
  /** Mesmo personaId em todos os segmentos (prova de que a persona não muda). */
  personaId: z.string().min(1),
  /** true só no último: contém o fechamento + CTA. */
  containsCta: z.boolean(),
});
export type MasterScriptSegment = z.infer<typeof MasterScriptSegmentSchema>;

export const MasterScriptSchema = z.object({
  version: z.literal(1),
  text: z.string().min(1),
  wordCount: z.int().positive(),
  targetSeconds: z.number().positive(),
  targetWords: z.object({ min: z.int().positive(), max: z.int().positive() }),
  sections: z.object({ hook: z.string(), body: z.string(), demo: z.string(), closing: z.string(), cta: z.string().min(1) }),
  persona: ScriptPersonaSchema,
  segments: z.array(MasterScriptSegmentSchema).min(1),
  /** Ajustes determinísticos feitos sem nova chamada paga (espaços, pontuação). */
  normalizations: z.array(z.string()).default([]),
  /** Avisos de estilo que não justificam nova tentativa paga. */
  warnings: z.array(z.string()).default([]),
});
export type MasterScript = z.infer<typeof MasterScriptSchema>;
