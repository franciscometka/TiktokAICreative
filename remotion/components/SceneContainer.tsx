import { AbsoluteFill, OffthreadVideo, useCurrentFrame } from "remotion";
import { transitionIn } from "../styles/animation";
import type { SceneProps } from "../types/props";
import { GeneratedVideoPlaceholder } from "./GeneratedVideoPlaceholder";
import { ProductImage } from "./ProductImage";
import { TextCard } from "./TextCard";

/** Escolhe a estratégia visual da cena (vinda do manifest) e aplica a transição de entrada. */
export function SceneContainer({ scene }: { scene: SceneProps }) {
  const frame = useCurrentFrame();
  const t = transitionIn(scene.transition, frame);

  let content;
  if (scene.video) {
    content = <OffthreadVideo src={scene.video.src} muted={scene.video.muted !== false} style={{ width: "100%", height: "100%", objectFit: scene.video.fit ?? "contain" }} />;
  } else if (scene.kind === "generated_video") {
    content = (
      <GeneratedVideoPlaceholder
        image={scene.image}
        label={scene.placeholder?.label ?? "MOCK · VÍDEO IA"}
        description={scene.placeholder?.description ?? null}
        durationFrames={scene.durationFrames}
        index={scene.index}
      />
    );
  } else if (scene.kind === "product_image" && scene.image) {
    content = <ProductImage image={scene.image} motion={scene.motion} durationFrames={scene.durationFrames} index={scene.index} />;
  } else {
    content = <TextCard text={scene.onScreenText} visualSource={scene.visualSource} />;
  }

  return (
    <AbsoluteFill style={{ opacity: t.opacity, transform: `translateY(${t.translateY}px) scale(${t.scale})` }}>
      {content}
    </AbsoluteFill>
  );
}
