import type { CSSProperties } from "react";
import { useCurrentFrame } from "remotion";
import { CAPTION_V3, COLORS, FONT } from "../styles/theme";

/**
 * Caption V3 (Lote 5.7) — componente ÚNICO de legenda. Layout 100% determinístico:
 *   - caixa FIXA (left/width/bottom/height em px constantes), centralizada no canvas
 *     (margens simétricas: a coluna de botões do TikTok não puxa o centro para a esquerda);
 *   - nenhuma rotation/skew/transform/animação de posição: a âncora é a mesma em todo frame;
 *   - text-align center, line-height fixo, no máximo 2 linhas (quebra decidida no plano);
 *   - base alinhada pelo fundo da caixa: 1 ou 2 linhas mantêm a mesma linha de base.
 * Só a opacidade entra/sai (2 frames), sem mexer na posição.
 */

export interface CaptionV3Item {
  text: string;
  lines?: string[];
  startFrame: number;
  endFrame: number;
  emphasis: string[];
}

export const CAPTION_V3_BOX = {
  left: CAPTION_V3.sideMargin,
  width: CAPTION_V3.canvasWidth - CAPTION_V3.sideMargin * 2,
  bottom: CAPTION_V3.bottom,
  height: Math.ceil(CAPTION_V3.fontSize * CAPTION_V3.lineHeight * 2),
} as const;

function emphasize(text: string, emphasis: readonly string[]) {
  if (emphasis.length === 0) return text;
  const pattern = new RegExp(`(${emphasis.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(pattern).map((part, i) => (emphasis.includes(part) ? <span key={i} style={{ color: COLORS.highlight }}>{part}</span> : part));
}

/** Estilo da caixa: exportado para os testes provarem que não há transform/rotação. */
export function captionV3BoxStyle(): CSSProperties {
  return {
    position: "absolute", left: CAPTION_V3_BOX.left, width: CAPTION_V3_BOX.width, bottom: CAPTION_V3_BOX.bottom, height: CAPTION_V3_BOX.height,
    display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", transform: "none",
  };
}

export function CaptionV3({ captions }: { captions: readonly CaptionV3Item[] }) {
  const frame = useCurrentFrame();
  const current = captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!current) return null;
  const lines = (current.lines?.length ? current.lines : [current.text]).slice(0, 2);
  const opacity = Math.min(1, (frame - current.startFrame + 1) / 2);
  return (
    <div style={{ ...captionV3BoxStyle(), opacity }}>
      {lines.map((line, i) => (
        <div key={i} style={{
          color: COLORS.white, fontFamily: FONT.family, fontSize: CAPTION_V3.fontSize, lineHeight: CAPTION_V3.lineHeight, fontWeight: FONT.weights.heavy,
          letterSpacing: 0, textAlign: "center", whiteSpace: "nowrap", maxWidth: CAPTION_V3_BOX.width,
          textShadow: "0 0 3px #000, 0 2px 4px rgba(0,0,0,0.85), 0 0 12px rgba(0,0,0,0.4)",
        }}>
          {emphasize(line, current.emphasis)}
        </div>
      ))}
    </div>
  );
}
