import { Easing, interpolate } from "remotion";
import { MOTION } from "./theme";
import type { SceneMotion, SceneTransition } from "../types/props";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const easeOut = Easing.out(Easing.cubic);

/** Entrada suave: opacidade + leve subida. `frame` é relativo ao início do elemento. */
export function enter(frame: number, frames: number = MOTION.enterFrames, distance: number = MOTION.slideDistance) {
  const t = interpolate(frame, [0, frames], [0, 1], { ...clamp, easing: easeOut });
  return { opacity: t, translateY: (1 - t) * distance };
}

/** Saída suave nos últimos `frames` antes de `endFrame` (relativos ao mesmo zero). */
export function exit(frame: number, endFrame: number, frames: number = MOTION.exitFrames) {
  return interpolate(frame, [endFrame - frames, endFrame], [1, 0], clamp);
}

/** Movimento da imagem na cena (sem bounce). `index` alterna direção para variar o ritmo. */
export function imageMotion(motion: SceneMotion, frame: number, durationFrames: number, index: number) {
  const p = interpolate(frame, [0, Math.max(1, durationFrames)], [0, 1], clamp);
  const z = MOTION.imageZoom;
  const pan = MOTION.imagePan * 100;
  const dir = index % 2 === 0 ? 1 : -1;
  switch (motion) {
    case "ken_burns":
      // Alterna zoom in / zoom out com um leve deslocamento.
      return { scale: dir > 0 ? 1 + z * p : 1 + z * (1 - p), x: dir * (p - 0.5) * pan * 0.5, y: 0 };
    case "zoom_in":
      return { scale: 1 + z * 1.2 * p, x: 0, y: 0 };
    case "pan":
      return { scale: 1 + z, x: dir * (p - 0.5) * 2 * pan, y: 0 };
    case "crop":
      // Recorte mais fechado com pan vertical lento.
      return { scale: 1 + z * 1.6, x: 0, y: dir * (0.5 - p) * pan };
    case "none":
      return { scale: 1 + z * 0.15, x: 0, y: 0 };
  }
}

/** Entrada da cena conforme a transição planejada. Não altera a duração total. */
export function transitionIn(transition: SceneTransition, frame: number) {
  if (transition === "cut") return { opacity: 1, translateY: 0, scale: 1 };
  const t = interpolate(frame, [0, MOTION.crossfadeFrames], [0, 1], { ...clamp, easing: easeOut });
  switch (transition) {
    case "fade":
      return { opacity: t, translateY: 0, scale: 1 };
    case "slide":
      return { opacity: t, translateY: (1 - t) * MOTION.slideDistance * 1.5, scale: 1 };
    case "zoom":
      return { opacity: t, translateY: 0, scale: 1 + (1 - t) * 0.05 };
  }
}
