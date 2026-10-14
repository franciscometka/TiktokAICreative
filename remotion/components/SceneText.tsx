import { useCurrentFrame } from "remotion";
import { enter, exit } from "../styles/animation";
import { COLORS, FONT, LAYOUT, RADIUS, SAFE_AREA, TYPE } from "../styles/theme";

/**
 * Texto curto da cena (onScreenText) sobre imagem: bloco claro compacto no terço superior.
 * `belowLabel`: cena placeholder — começa abaixo do selo "MOCK · VÍDEO IA", que nunca fica coberto.
 */
export function SceneText({ text, durationFrames, belowLabel = false }: { text: string; durationFrames: number; belowLabel?: boolean }) {
  const frame = useCurrentFrame();
  if (!text.trim()) return null;
  const a = enter(frame);
  const opacity = a.opacity * exit(frame, durationFrames);
  return (
    <div
      style={{
        position: "absolute",
        top: belowLabel ? LAYOUT.placeholderLabelTop + LAYOUT.placeholderLabelHeight : LAYOUT.sceneTextTop,
        left: SAFE_AREA.left,
        right: SAFE_AREA.right,
        display: "flex",
        opacity,
        transform: `translateY(${a.translateY * 0.6}px)`,
      }}
    >
      <span
        style={{
          backgroundColor: COLORS.white,
          color: COLORS.ink,
          padding: "14px 22px 16px",
          borderRadius: RADIUS.sm,
          fontFamily: FONT.family,
          fontSize: TYPE.sceneText.size,
          lineHeight: TYPE.sceneText.lineHeight,
          letterSpacing: TYPE.sceneText.tracking,
          fontWeight: TYPE.sceneText.weight,
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
          maxWidth: "100%",
          overflowWrap: "break-word",
        }}
      >
        {text}
      </span>
    </div>
  );
}
