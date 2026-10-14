import { AUDIO_FIT_POLICY } from "@/config/audio-policy";
import type { AudioFit } from "@/domain/audio";

/**
 * Compara a duração planejada com a fala real. Nunca corta fala; nunca dispara chamada paga.
 * - fits: diferença dentro da tolerância.
 * - too_short: fala termina antes (o vídeo segue com o plano; sobra imagem no fim).
 * - too_long: fala passa do fim. Pouco → "extend" (estende o fim localmente). Muito → "review".
 * Áudio mock (measured = false) nunca pede revisão: a duração dele é fictícia.
 */
export function evaluateAudioFit(
  input: { targetSeconds: number; speechSeconds: number; measured: boolean },
  policy = AUDIO_FIT_POLICY,
): AudioFit {
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const difference = round3(input.speechSeconds - input.targetSeconds);
  const base = {
    targetDuration: input.targetSeconds,
    actualDuration: round3(input.speechSeconds),
    difference,
    measured: input.measured,
  };
  if (Math.abs(difference) <= policy.toleranceSeconds) {
    // Cabe, mas se a fala encosta no fim, garante o respiro final sem cortar nada.
    const needed = round3(Math.max(0, input.speechSeconds + policy.tailSeconds - input.targetSeconds));
    return { ...base, status: "fits", action: needed > 0 && input.measured ? "extend" : "none", extendSeconds: input.measured ? needed : 0 };
  }
  if (difference < 0) return { ...base, status: "too_short", action: "none", extendSeconds: 0 };

  const extendSeconds = round3(difference + policy.tailSeconds);
  if (!input.measured) return { ...base, status: "too_long", action: "none", extendSeconds: 0 };
  const limit = Math.max(policy.extendMaxSeconds, policy.extendMaxRatio * input.targetSeconds);
  return { ...base, status: "too_long", action: difference <= limit ? "extend" : "review", extendSeconds };
}
