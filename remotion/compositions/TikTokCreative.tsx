import { AbsoluteFill, Sequence } from "remotion";
import { CallToAction } from "../components/CallToAction";
import { Captions } from "../components/Caption";
import { Headline } from "../components/Headline";
import { ProgressBar } from "../components/ProgressBar";
import { SceneContainer } from "../components/SceneContainer";
import { SceneText } from "../components/SceneText";
import { MOTION, COLORS, FONT } from "../styles/theme";
import { loadFonts } from "../styles/fonts";
import type { CreativeProps } from "../types/props";

loadFonts();

/**
 * Anúncio vertical 1080x1920. Toda a linha do tempo vem pronta nas props (frames).
 * Camadas: cenas → texto da cena → hook → legendas → CTA → barra de progresso.
 */
export function TikTokCreative(props: CreativeProps) {
  const { scenes, captions, hook, cta, product, durationInFrames } = props;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, fontFamily: FONT.family }}>
      {scenes.map((scene, i) => {
        // Em transições não-corte, a cena anterior continua por baixo da que entra
        // (sobreposição curta); a duração total do vídeo não muda.
        const next = scenes[i + 1];
        const overlap = next && next.transition !== "cut" ? MOTION.crossfadeFrames : 0;
        return (
          <Sequence
            key={scene.id}
            from={scene.startFrame}
            durationInFrames={Math.min(scene.durationFrames + overlap, durationInFrames - scene.startFrame)}
            name={`Cena ${i + 1} · ${scene.kind}`}
          >
            <SceneContainer scene={scene} />
          </Sequence>
        );
      })}

      {scenes.map((scene, i) => {
        // Texto da cena só sobre imagem/placeholder; text_card já é o próprio texto.
        if (scene.kind === "text_card") return null;
        const hookCovers = hook && i === 0;
        const start = hookCovers ? Math.min(hook.endFrame, scene.startFrame + scene.durationFrames) : scene.startFrame;
        const end = Math.min(scene.startFrame + scene.durationFrames, cta.startFrame);
        if (end - start < 12) return null;
        return (
          <Sequence key={`text-${scene.id}`} from={start} durationInFrames={end - start} name={`Texto ${i + 1}`}>
            <SceneText text={scene.onScreenText} durationFrames={end - start} belowLabel={scene.placeholder !== null} />
          </Sequence>
        );
      })}

      {hook && (
        <Sequence from={0} durationInFrames={hook.endFrame} name="Hook">
          <Headline text={hook.text} endFrame={hook.endFrame} />
        </Sequence>
      )}

      <Captions captions={captions} />

      <Sequence from={cta.startFrame} durationInFrames={durationInFrames - cta.startFrame} name="CTA">
        <CallToAction text={cta.text} productName={product.name} priceLabel={product.priceLabel} benefit={product.benefit} />
      </Sequence>

      <ProgressBar />
    </AbsoluteFill>
  );
}
