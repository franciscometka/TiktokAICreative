import { interpolate, useCurrentFrame } from "remotion";
import { CANVAS, COLORS, FONT, LAYOUT, RADIUS, SAFE_AREA, SHADOW, SPACE, TYPE } from "../styles/theme";
import type { CaptionProps } from "../types/props";

/**
 * Legenda estilo TikTok/Reels: um trecho curto por vez, branco sobre faixa escura translúcida
 * (legível sobre qualquer imagem), até 2 linhas,
 * acima da área inferior coberta pela interface. Sem karaokê (não há timing por palavra).
 */
export function Captions({ captions }: { captions: CaptionProps[] }) {
  const frame = useCurrentFrame();
  const current = captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!current) return null;
  const local = frame - current.startFrame;
  const pop = interpolate(local, [0, 4], [0.94, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = interpolate(local, [0, 3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE_AREA.left,
        right: SAFE_AREA.right,
        bottom: CANVAS.height - LAYOUT.captionBottom,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          color: COLORS.white,
          fontFamily: FONT.family,
          fontSize: TYPE.caption.size,
          lineHeight: TYPE.caption.lineHeight,
          letterSpacing: TYPE.caption.tracking,
          fontWeight: TYPE.caption.weight,
          textAlign: "center",
          textShadow: SHADOW.captionText,
          backgroundColor: COLORS.captionBackdrop,
          padding: `${SPACE.xs}px ${SPACE.sm}px`,
          borderRadius: RADIUS.md,
          overflowWrap: "anywhere",
          display: "-webkit-box",
          WebkitLineClamp: LAYOUT.captionMaxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          opacity,
          transform: `scale(${pop})`,
        }}
      >
        {current.text}
      </div>
    </div>
  );
}
