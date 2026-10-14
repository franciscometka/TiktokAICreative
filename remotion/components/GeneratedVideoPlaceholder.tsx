import { AbsoluteFill } from "remotion";
import { COLORS, FONT, LAYOUT, RADIUS, SAFE_AREA, TYPE } from "../styles/theme";
import type { ImageProps } from "../types/props";
import { ProductImage } from "./ProductImage";

/**
 * Cena que FUTURAMENTE será vídeo gerado por IA. Enquanto o provider é mock, mostra a foto do
 * produto (se houver) escurecida, com movimento lento, hachura diagonal e um selo inequívoco —
 * nunca pode ser confundida com vídeo gerado.
 * No Lote 5, um vídeo real substitui este componente no nível do asset.
 */
export function GeneratedVideoPlaceholder({
  image,
  label,
  description,
  durationFrames,
  index,
}: {
  image: ImageProps | null;
  label: string;
  description: string | null;
  durationFrames: number;
  index: number;
}) {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.placeholderBg }}>
      {image && <ProductImage image={image} motion="zoom_in" durationFrames={durationFrames} index={index} dim={0.25} />}
      <AbsoluteFill
        style={{
          backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,0.07) 0 18px, transparent 18px 52px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: LAYOUT.placeholderLabelTop,
          left: SAFE_AREA.left,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 22px",
          borderRadius: RADIUS.pill,
          border: "3px dashed rgba(255,255,255,0.7)",
          backgroundColor: "rgba(0,0,0,0.62)",
          color: COLORS.white,
          fontFamily: FONT.family,
          fontSize: TYPE.label.size,
          fontWeight: TYPE.label.weight,
          letterSpacing: TYPE.label.tracking,
        }}
      >
        <span style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: COLORS.accent }} />
        {label}
      </div>
      {description && (
        <div
          style={{
            position: "absolute",
            top: LAYOUT.placeholderLabelTop + LAYOUT.placeholderLabelHeight,
            left: SAFE_AREA.left,
            right: SAFE_AREA.right,
            color: COLORS.muted,
            fontFamily: FONT.family,
            fontSize: 26,
            lineHeight: 1.3,
          }}
        >
          {description}
        </div>
      )}
    </AbsoluteFill>
  );
}
