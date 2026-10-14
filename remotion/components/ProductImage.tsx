import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import { imageMotion } from "../styles/animation";
import { CANVAS, COLORS, SAFE_AREA } from "../styles/theme";
import type { ImageProps, SceneMotion } from "../types/props";

/**
 * Imagem real do produto com movimento leve.
 * - cover: preenche 1080x1920 (imagens em pé), sem distorção (object-fit).
 * - contain: produto inteiro, com margem de segurança, sobre a mesma foto desfocada e escurecida.
 */
export function ProductImage({
  image,
  motion,
  durationFrames,
  index,
  dim = 0,
}: {
  image: ImageProps;
  motion: SceneMotion;
  durationFrames: number;
  index: number;
  /** 0–1: escurece a imagem (usado pelo placeholder). */
  dim?: number;
}) {
  const frame = useCurrentFrame();
  const m = imageMotion(motion, frame, durationFrames, index);
  const transform = `translate(${m.x}%, ${m.y}%) scale(${m.scale})`;

  if (image.fit === "cover") {
    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden" }}>
        <Img src={image.src} style={{ width: "100%", height: "100%", objectFit: "cover", transform }} />
        {dim > 0 && <AbsoluteFill style={{ backgroundColor: `rgba(8,8,10,${dim})` }} />}
      </AbsoluteFill>
    );
  }

  // Área útil para o produto inteiro: largura com respiro lateral, altura entre topo e legendas.
  const box = {
    left: SAFE_AREA.left,
    right: SAFE_AREA.left,
    top: SAFE_AREA.top + 120,
    bottom: SAFE_AREA.bottom + 60,
  };
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden" }}>
      <Img
        src={image.src}
        style={{
          position: "absolute",
          inset: -80,
          width: CANVAS.width + 160,
          height: CANVAS.height + 160,
          objectFit: "cover",
          filter: "blur(48px) saturate(1.1)",
          opacity: 0.55,
        }}
      />
      <AbsoluteFill style={{ backgroundColor: `rgba(8,8,10,${0.28 + dim})` }} />
      <div style={{ position: "absolute", ...box, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Img
          src={image.src}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transform, borderRadius: 6 }}
        />
      </div>
    </AbsoluteFill>
  );
}
