import { z } from "zod";

/**
 * Lote 6 — Edição por texto ("Quer mudar alguma coisa?"). Estrutura o pedido ANTES de gastar:
 * tipo, escopo, instruções, ativos afetados e custo estimado. A execução de cada tipo fica para
 * lotes seguintes; nada pago acontece sem mostrar a estimativa e pedir confirmação.
 */

export const CHANGE_REQUEST_TYPES = ["tone", "cta", "voice_speed", "duration", "environment", "avatar", "script", "other"] as const;
export const ChangeRequestTypeSchema = z.enum(CHANGE_REQUEST_TYPES);
export type ChangeRequestType = z.infer<typeof ChangeRequestTypeSchema>;

/** O que precisa ser refeito. */
export const AFFECTED_ASSETS = ["master_script", "narration", "reference", "aroll_clips", "last_clip", "render"] as const;
export type AffectedAsset = (typeof AFFECTED_ASSETS)[number];

export const ChangeRequestSchema = z.object({
  type: ChangeRequestTypeSchema,
  /** whole_video = refaz tudo depois do roteiro; final_segment = só o último trecho; render_only = R$0. */
  scope: z.enum(["whole_video", "final_segment", "render_only"]),
  instructions: z.string().trim().min(1).max(500),
  /** Parâmetros extraídos (ex.: duração 45, avatar "Marina"). */
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  affectedAssets: z.array(z.enum(AFFECTED_ASSETS)).min(1),
  estimatedCost: z.object({ brl: z.number().nonnegative(), label: z.string(), clipsToRegenerate: z.int().nonnegative() }),
  /** Execução automática ainda não implementada para este tipo (Lote 6 prepara a arquitetura). */
  executable: z.boolean(),
});
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

interface Rule { type: ChangeRequestType; pattern: RegExp }
const RULES: readonly Rule[] = [
  { type: "duration", pattern: /\b(30|45|60)\s*(s\b|seg|segundos)/i },
  { type: "avatar", pattern: /\b(?:[Uu]s(?:e|a|ar)|[Tt]roque\s+para|[Cc]oloque)\s+(?:a|o)\s+(\p{Lu}\p{L}+)/u },
  { type: "voice_speed", pattern: /(mais\s+devagar|mais\s+r[áa]pido|velocidade|fale?\s+(mais\s+)?(lento|calma))/i },
  { type: "cta", pattern: /\bcta\b|chamada\s+final|final\s+do\s+v[íi]deo/i },
  { type: "environment", pattern: /ambiente|cen[áa]rio|fundo|cozinha|quarto|sala|banheiro|oficina|ao\s+ar\s+livre/i },
  { type: "tone", pattern: /animad|energ|s[ée]ri[oa]|engra[çc]ad|tom\b|mais\s+natural|empolgad/i },
  { type: "script", pattern: /fala|roteiro|texto|frase/i },
];

export interface ChangeCostInputs {
  /** Custo estimado (BRL) de UM trecho de vídeo da apresentadora. */
  clipBrl: number;
  clips: number;
  /** Narração completa (Voice Lock) em BRL; 0 se fala nativa. */
  narrationBrl: number;
  /** Planejamento/roteiro (Claude) em BRL. */
  scriptBrl: number;
  referenceBrl: number;
}

const brl = (n: number) => `R$ ${n.toFixed(2).replace(".", ",")}`;

/** Interpretação determinística (sem LLM, sem custo) do pedido em linguagem natural. */
export function parseChangeRequest(raw: string, costs: ChangeCostInputs): ChangeRequest {
  const instructions = raw.trim().slice(0, 500);
  if (!instructions) throw new Error("Descreva o que você quer mudar.");
  const rule = RULES.find((r) => r.pattern.test(instructions));
  const type: ChangeRequestType = rule?.type ?? "other";
  const params: Record<string, string | number> = {};
  if (type === "duration") params.durationSeconds = Number(/\b(30|45|60)(?=\s*(s\b|seg))/i.exec(instructions)?.[1]);
  if (type === "avatar") params.avatarName = RULES[1]!.pattern.exec(instructions)?.[1] ?? "";
  const plan: Record<ChangeRequestType, { scope: ChangeRequest["scope"]; assets: AffectedAsset[]; clips: number; extra: number; executable: boolean }> = {
    tone: { scope: "whole_video", assets: ["master_script", "narration", "aroll_clips", "render"], clips: costs.clips, extra: costs.scriptBrl + costs.narrationBrl, executable: false },
    script: { scope: "whole_video", assets: ["master_script", "narration", "aroll_clips", "render"], clips: costs.clips, extra: costs.scriptBrl + costs.narrationBrl, executable: false },
    cta: { scope: "final_segment", assets: ["master_script", "last_clip", "render"], clips: 1, extra: costs.scriptBrl, executable: false },
    voice_speed: { scope: "whole_video", assets: ["narration", "aroll_clips", "render"], clips: costs.clips, extra: costs.narrationBrl, executable: false },
    duration: { scope: "whole_video", assets: ["master_script", "narration", "aroll_clips", "render"], clips: costs.clips, extra: costs.scriptBrl + costs.narrationBrl, executable: false },
    environment: { scope: "whole_video", assets: ["reference", "aroll_clips", "render"], clips: costs.clips, extra: costs.referenceBrl, executable: false },
    avatar: { scope: "whole_video", assets: ["reference", "narration", "aroll_clips", "render"], clips: costs.clips, extra: costs.referenceBrl + costs.narrationBrl, executable: false },
    other: { scope: "whole_video", assets: ["master_script", "aroll_clips", "render"], clips: costs.clips, extra: costs.scriptBrl, executable: false },
  };
  const p = plan[type];
  const clips = type === "duration" && typeof params.durationSeconds === "number" ? Math.max(costs.clips, Math.round(costs.clips * (params.durationSeconds / 30))) : p.clips;
  const total = Math.round((clips * costs.clipBrl + p.extra) * 100) / 100;
  return ChangeRequestSchema.parse({
    type, scope: p.scope, instructions, params, affectedAssets: p.assets, executable: p.executable,
    estimatedCost: { brl: total, clipsToRegenerate: clips, label: `Estimativa: ${brl(total)} (${clips} trecho${clips === 1 ? "" : "s"} novo${clips === 1 ? "" : "s"})` },
  });
}
