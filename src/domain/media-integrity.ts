import { z } from "zod";

/**
 * Integridade de duração de um clipe de vídeo gerado. Três valores SEPARADOS, nunca misturados:
 * - requestedDurationSeconds: o que foi pedido (e cobrado) ao provider;
 * - providerReportedDurationSeconds: o que o provider informou (Runway não informa → ausente);
 * - actualMediaDurationSeconds: medido do MP4 SALVO (fonte da verdade).
 */

export const CLIP_DURATION_STATUSES = ["valid", "truncated", "too_long", "incomplete_file", "unreadable"] as const;
export const ClipDurationStatusSchema = z.enum(CLIP_DURATION_STATUSES);
export type ClipDurationStatus = z.infer<typeof ClipDurationStatusSchema>;

export const ClipDurationCheckSchema = z.object({
  requestedDurationSeconds: z.number().positive(),
  providerReportedDurationSeconds: z.number().nonnegative().optional(),
  actualMediaDurationSeconds: z.number().nonnegative().optional(),
  toleranceSeconds: z.number().nonnegative(),
  status: ClipDurationStatusSchema,
  /** O provider informou uma duração diferente da medida (só auditoria; vale a medida). */
  providerMismatch: z.boolean(),
});
export type ClipDurationCheck = z.infer<typeof ClipDurationCheckSchema>;

/** Tolerância: 0,25s ou 5% do pedido (o maior). Ex.: Runway entrega 5,042s para 5s pedidos. */
export function durationTolerance(requestedSeconds: number): number {
  return Math.max(0.25, requestedSeconds * 0.05);
}

/** Pura: compara pedido × medido e classifica. Só "valid" pode ir para o render. */
export function checkClipDuration(input: {
  requestedSeconds: number;
  providerReportedSeconds?: number;
  actualSeconds: number | undefined;
  fileComplete: boolean;
}): ClipDurationCheck {
  const tolerance = durationTolerance(input.requestedSeconds);
  const actual = input.actualSeconds;
  let status: ClipDurationStatus;
  if (!input.fileComplete) status = "incomplete_file";
  else if (actual === undefined) status = "unreadable";
  else if (actual < input.requestedSeconds - tolerance) status = "truncated";
  else if (actual > input.requestedSeconds + tolerance) status = "too_long";
  else status = "valid";
  return {
    requestedDurationSeconds: input.requestedSeconds,
    ...(input.providerReportedSeconds !== undefined ? { providerReportedDurationSeconds: input.providerReportedSeconds } : {}),
    ...(actual !== undefined ? { actualMediaDurationSeconds: actual } : {}),
    toleranceSeconds: Math.round(tolerance * 1000) / 1000,
    status,
    providerMismatch:
      input.providerReportedSeconds !== undefined && actual !== undefined && Math.abs(input.providerReportedSeconds - actual) > tolerance,
  };
}

const s = (n: number | undefined) => (n === undefined ? "indisponível" : `${n.toFixed(2).replace(".", ",")}s`);

/** Mensagem clara para a UI quando o clipe é rejeitado. */
export function clipRejectionMessage(check: ClipDurationCheck, sceneNumber: number): string {
  const reason: Record<ClipDurationStatus, string> = {
    valid: "",
    truncated: "o arquivo é mais curto que o solicitado",
    too_long: "o arquivo é mais longo que o solicitado",
    incomplete_file: "o arquivo está incompleto (download ou gravação cortados)",
    unreadable: "não foi possível ler a duração do arquivo",
  };
  return (
    `Clipe da cena ${sceneNumber} rejeitado: ${reason[check.status]} ` +
    `(solicitado ${s(check.requestedDurationSeconds)}, provider ${s(check.providerReportedDurationSeconds)}, arquivo real ${s(check.actualMediaDurationSeconds)}; ` +
    `tolerância ${s(check.toleranceSeconds)}). Custo preservado no ledger; nenhuma nova tentativa automática; o clipe não vai para o render.`
  );
}

const fmt2 = (n: number | undefined) => (n === undefined ? "indisponível" : `${n.toFixed(2)}s`);

/** Três durações SEPARADAS: o pedido, o que o provider disse e o que o arquivo salvo tem de fato. */
export function durationReport(media: ClipDurationCheck | undefined): string {
  if (!media) return "solicitado: indisponível\nprovider: indisponível\narquivo real: indisponível (clipe não salvo)";
  return [
    `solicitado: ${fmt2(media.requestedDurationSeconds)}`,
    `provider: ${fmt2(media.providerReportedDurationSeconds)}`,
    `arquivo real: ${fmt2(media.actualMediaDurationSeconds)}${media.status === "valid" ? "" : ` — REJEITADO (${media.status})`}`,
  ].join("\n");
}
