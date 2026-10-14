import { AbsoluteFill, useCurrentFrame } from "remotion";
import { enter } from "../styles/animation";
import { COLORS, FONT, SAFE_AREA, TYPE } from "../styles/theme";
import type { SceneVisualSource } from "../types/props";

/**
 * Composição tipográfica (text_card / simple_background).
 * text_card: papel claro, texto grande escuro. simple_background: fundo escuro com barra de acento.
 * Não repete o nome do produto: nome e preço aparecem uma única vez, no CTA final.
 */
export function TextCard({
  text,
  visualSource,
}: {
  text: string;
  visualSource: SceneVisualSource | null;
}) {
  const frame = useCurrentFrame();
  const dark = visualSource === "simple_background";
  const a = enter(frame);
  const fg = dark ? COLORS.white : COLORS.ink;
  const long = text.length > 34;

  return (
    <AbsoluteFill style={{ backgroundColor: dark ? COLORS.ink : COLORS.paper }}>
      <div
        style={{
          position: "absolute",
          left: SAFE_AREA.left,
          right: SAFE_AREA.right,
          top: SAFE_AREA.top,
          bottom: SAFE_AREA.bottom,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 28,
          opacity: a.opacity,
          transform: `translateY(${a.translateY}px)`,
        }}
      >
        <div style={{ width: 88, height: 10, backgroundColor: COLORS.accent }} />
        <div
          style={{
            color: fg,
            fontFamily: FONT.family,
            fontSize: long ? TYPE.cardText.size * 0.78 : TYPE.cardText.size,
            lineHeight: TYPE.cardText.lineHeight,
            letterSpacing: TYPE.cardText.tracking,
            fontWeight: TYPE.cardText.weight,
            overflowWrap: "break-word",
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
}
