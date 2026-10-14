import { useCurrentFrame } from "remotion";
import { enter, exit } from "../styles/animation";
import { COLORS, FONT, LAYOUT, SAFE_AREA, SHADOW, TYPE } from "../styles/theme";

/** Hook de abertura: grande nos primeiros segundos, depois sai para o vídeo respirar. */
export function Headline({ text, endFrame }: { text: string; endFrame: number }) {
  const frame = useCurrentFrame();
  if (frame >= endFrame) return null;
  const a = enter(frame);
  const opacity = a.opacity * exit(frame, endFrame);
  const scale = 0.96 + 0.04 * a.opacity;
  return (
    <>
      {/* Véu discreto no topo para legibilidade sobre qualquer imagem. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          height: 900,
          background: "linear-gradient(180deg, rgba(8,8,10,0.62) 0%, rgba(8,8,10,0) 100%)",
          opacity,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: LAYOUT.hookTop,
          left: SAFE_AREA.left,
          right: SAFE_AREA.right,
          color: COLORS.white,
          fontFamily: FONT.family,
          fontSize: text.length > 48 ? TYPE.hook.size * 0.82 : TYPE.hook.size,
          lineHeight: TYPE.hook.lineHeight,
          letterSpacing: TYPE.hook.tracking,
          fontWeight: TYPE.hook.weight,
          textShadow: SHADOW.captionText,
          opacity,
          transform: `translateY(${a.translateY}px) scale(${scale})`,
          transformOrigin: "left top",
          overflowWrap: "break-word",
        }}
      >
        {text}
      </div>
    </>
  );
}
