import { z } from "zod";
import { ContinuityActionSchema, NATURAL_TRANSITIONS } from "./edit";

/** Lote 6.2 — papel do segmento na estrutura V2 (hook → característica → demo → informação → CTA). */
export const SCRIPT_BEATS = ["hook", "main_feature", "second_feature_demo", "important_info", "closing_cta"] as const;
export const ScriptBeatSchema = z.enum(SCRIPT_BEATS);
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

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
  /**
   * Lote 6.2 (Script V2): o que a apresentadora FAZ enquanto fala, a ação com que entra/sai (cut
   * on action) e a transição pretendida para a entrada. Ausentes em roteiros anteriores.
   */
  beat: ScriptBeatSchema.optional(),
  visualAction: z.string().max(200).optional(),
  entryAction: ContinuityActionSchema.optional(),
  exitAction: ContinuityActionSchema.optional(),
  transitionIntent: z.enum(["opening", ...NATURAL_TRANSITIONS]).optional(),
  /** Por que o corte cai aqui: fim de pensamento/frase, ação visual ou pausa natural. */
  splitReason: z.enum(["opening", "thought_end", "sentence_end", "visual_action", "natural_pause"]).optional(),
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
