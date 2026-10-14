import { useCurrentFrame, useVideoConfig } from "remotion";
import { LAYOUT, SAFE_AREA } from "../styles/theme";

/** Barra fina de progresso no topo da área segura (ritmo visual; não imita a barra do app). */
export function ProgressBar() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = Math.min(1, (frame + 1) / durationInFrames);
  return (
    <div
      style={{
        position: "absolute",
        top: LAYOUT.progressTop,
        left: SAFE_AREA.left,
        right: SAFE_AREA.right,
        height: 6,
        borderRadius: 3,
        backgroundColor: "rgba(255,255,255,0.22)",
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${p * 100}%`, height: "100%", backgroundColor: "rgba(255,255,255,0.9)" }} />
    </div>
  );
}
