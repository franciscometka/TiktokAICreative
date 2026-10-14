import { useCurrentFrame } from "remotion";
import { enter } from "../styles/animation";
import { CANVAS, COLORS, FONT, LAYOUT, RADIUS, SAFE_AREA, SHADOW, TYPE } from "../styles/theme";
import { PriceTag } from "./PriceTag";

/**
 * Fechamento: nome do produto, preço (só aqui, e só se informado) e o CTA do plano.
 * Texto puro — nenhum ícone ou botão que imite a interface do aplicativo.
 */
export function CallToAction({
  text,
  productName,
  priceLabel,
  benefit,
}: {
  text: string;
  productName: string;
  priceLabel: string | null;
  benefit: string | null;
}) {
  const frame = useCurrentFrame();
  const a = enter(frame, 10);
  const b = enter(frame - 6, 10);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 1100,
          background: "linear-gradient(0deg, rgba(8,8,10,0.85) 0%, rgba(8,8,10,0.55) 55%, rgba(8,8,10,0) 100%)",
          opacity: a.opacity,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: SAFE_AREA.left,
          right: SAFE_AREA.right,
          bottom: CANVAS.height - LAYOUT.ctaBottom,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <div style={{ opacity: a.opacity, transform: `translateY(${a.translateY}px)` }}>
          <div
            style={{
              color: COLORS.muted,
              fontFamily: FONT.family,
              fontSize: TYPE.eyebrow.size,
              fontWeight: TYPE.eyebrow.weight,
              letterSpacing: TYPE.eyebrow.tracking,
              textTransform: "uppercase",
            }}
          >
            {productName}
          </div>
          {benefit && (
            <div style={{ marginTop: 10, color: COLORS.white, fontFamily: FONT.family, fontSize: 38, fontWeight: 600, lineHeight: 1.2 }}>
              {benefit}
            </div>
          )}
          {priceLabel && (
            <div style={{ marginTop: 18 }}>
              <PriceTag label={priceLabel} />
            </div>
          )}
        </div>
        <div
          style={{
            alignSelf: "flex-start",
            opacity: b.opacity,
            transform: `translateY(${b.translateY}px)`,
            backgroundColor: COLORS.accent,
            color: COLORS.white,
            padding: "22px 30px 24px",
            borderRadius: RADIUS.md,
            fontFamily: FONT.family,
            fontSize: TYPE.cta.size,
            lineHeight: TYPE.cta.lineHeight,
            letterSpacing: TYPE.cta.tracking,
            fontWeight: TYPE.cta.weight,
            boxShadow: SHADOW.card,
            maxWidth: "100%",
            overflowWrap: "break-word",
          }}
        >
          {text}
        </div>
      </div>
    </>
  );
}
