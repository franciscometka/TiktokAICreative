import { Composition } from "remotion";
import { TikTokCreative } from "./compositions/TikTokCreative";
import { SAMPLE_PROPS } from "./sample-props";
import { COMPOSITION_ID, type CreativeProps } from "./types/props";

/** Duração, fps e tamanho vêm das props de cada render (nada fixo aqui). */
export function Root() {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={TikTokCreative}
      defaultProps={SAMPLE_PROPS}
      durationInFrames={SAMPLE_PROPS.durationInFrames}
      fps={SAMPLE_PROPS.fps}
      width={SAMPLE_PROPS.width}
      height={SAMPLE_PROPS.height}
      calculateMetadata={({ props }: { props: CreativeProps }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
}
