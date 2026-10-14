import { COMPOSITION_VERSION, type CreativeProps } from "./types/props";

/** Props de exemplo (sem imagens) só para registrar a composição; renders reais sempre passam props. */
export const SAMPLE_PROPS: CreativeProps = {
  meta: { creativeId: "sample", campaignId: null, compositionVersion: COMPOSITION_VERSION },
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 90,
  scenes: [
    {
      id: "s1",
      index: 0,
      startFrame: 0,
      durationFrames: 45,
      kind: "generated_video",
      visualSource: "generated_video",
      motion: "none",
      transition: "cut",
      onScreenText: "Exemplo",
      image: null,
      placeholder: { label: "MOCK · VÍDEO IA", description: null },
    },
    {
      id: "s2",
      index: 1,
      startFrame: 45,
      durationFrames: 45,
      kind: "text_card",
      visualSource: "text_card",
      motion: "none",
      transition: "fade",
      onScreenText: "Composição de exemplo",
      image: null,
      placeholder: null,
    },
  ],
  captions: [{ text: "Legenda de exemplo", startFrame: 10, endFrame: 40 }],
  hook: { text: "Hook de exemplo", endFrame: 45 },
  cta: { text: "Toque para saber mais", startFrame: 60 },
  product: { name: "Produto", priceLabel: null, benefit: null },
  audio: [],
  debug: false,
};
