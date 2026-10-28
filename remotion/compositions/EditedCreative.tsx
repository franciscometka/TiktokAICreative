import { AbsoluteFill, Audio, Easing, Img, interpolate, OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import { GeneratedVideoPlaceholder } from "../components/GeneratedVideoPlaceholder";
import { CaptionV3 } from "../components/CaptionV3";
import { enter } from "../styles/animation";
import { COLORS, FONT, MOTION, SAFE_AREA, SPACE } from "../styles/theme";
import type { CreativeProps, EditAudioProps, EditVisualProps } from "../types/props";

/**
 * Creative Editor V2 (Lote 5.6): UM vídeo contínuo. A-roll é a base; B-roll entra por cima do
 * áudio do A-roll. Todo visual é MUDO; o áudio vem só das faixas do Edit Plan (fala nativa do
 * A-roll), com trim e micro fades. Sem zooms de template, sem card final, sem barra de progresso.
 */

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Lote 6.2: frames em que o trecho anterior continua por baixo deste (blend curtíssimo). */
export function overlapFrames(next: EditVisualProps | undefined): number {
  if (!next) return 0;
  if (next.transition === "crossfade") return MOTION.crossfadeFrames;
  return next.transitionFx?.blendFrames ?? 0;
}

/**
 * Natural Transition Engine (Lote 6.2), só no início do trecho e por ≤ 6 frames:
 * micro punch (escala 100%↔103,5%), blur direcional (2–4 frames) e blend (≤ 4 frames). Nunca
 * flash/spin/slide/wipe; nenhum efeito toca o áudio.
 */
function entryEffect(visual: EditVisualProps, frame: number): { opacity: number; scale: number; blurPx: number } {
  const fx = visual.transitionFx;
  // Crossfade legado (V2): só quando o plano pediu explicitamente.
  if (!fx) return { opacity: visual.transition === "crossfade" ? interpolate(frame, [0, MOTION.crossfadeFrames], [0, 1], clamp) : 1, scale: visual.scale, blurPx: 0 };
  const opacity = fx.blendFrames > 0 ? interpolate(frame, [0, fx.blendFrames], [0, 1], clamp) : 1;
  const scale = fx.punch ? interpolate(frame, [0, Math.max(1, fx.frames)], [fx.punch.fromScale, fx.punch.toScale], { ...clamp, easing: Easing.out(Easing.cubic) }) : visual.scale;
  const blurPx = fx.blurDirection ? interpolate(frame, [0, Math.max(1, fx.frames)], [10, 0], clamp) : 0;
  return { opacity, scale, blurPx };
}

/** Blur DIRECIONAL de verdade (SVG feGaussianBlur com desvio só no eixo do movimento). */
function DirectionalBlur({ id, direction, px }: { id: string; direction: NonNullable<NonNullable<EditVisualProps["transitionFx"]>["blurDirection"]>; px: number }) {
  const horizontal = direction === "left" || direction === "right";
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <filter id={id} x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation={horizontal ? `${px} 0` : `0 ${px}`} /></filter>
    </svg>
  );
}

function EditVisual({ visual }: { visual: EditVisualProps }) {
  const frame = useCurrentFrame();
  const effect = entryEffect(visual, frame);
  const opacity = effect.opacity;
  const blurId = `blur-${visual.id}`;
  const blur = effect.blurPx > 0.05 && visual.transitionFx?.blurDirection ? visual.transitionFx.blurDirection : null;
  if (visual.kind === "placeholder" || !visual.src) {
    return (
      <AbsoluteFill style={{ opacity }}>
        <GeneratedVideoPlaceholder image={null} label={visual.placeholderLabel ?? "MOCK"} description={null} durationFrames={visual.durationFrames} index={0} />
      </AbsoluteFill>
    );
  }
  if (visual.kind === "image") {
    // Recorte do frame de referência: push-in lento a partir do foco (produto na mão).
    const crop = visual.crop;
    const scale = crop ? interpolate(frame, [0, Math.max(1, visual.durationFrames)], [crop.scaleFrom, crop.scaleTo], clamp) : visual.scale;
    const origin = crop ? `${crop.focusX * 100}% ${crop.focusY * 100}%` : "50% 50%";
    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden", opacity }}>
        <Img src={visual.src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: origin }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden", opacity }}>
      {blur && <DirectionalBlur id={blurId} direction={blur} px={effect.blurPx} />}
      <OffthreadVideo
        src={visual.src}
        muted
        trimBefore={visual.trimBeforeFrames}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${effect.scale})`, transformOrigin: "50% 42%", ...(blur ? { filter: `url(#${blurId})` } : {}) }}
      />
    </AbsoluteFill>
  );
}

function AudioTrack({ track }: { track: EditAudioProps }) {
  // Micro fades anti click/pop; o ganho por clipe vem do plano (normalização conservadora).
  const volume = (f: number) => {
    const fadeIn = track.fadeInFrames > 0 ? interpolate(f, [0, track.fadeInFrames], [0, 1], clamp) : 1;
    const fadeOut = track.fadeOutFrames > 0 ? interpolate(f, [track.durationFrames - track.fadeOutFrames, track.durationFrames], [1, 0], clamp) : 1;
    return track.gain * Math.min(fadeIn, fadeOut);
  };
  return <Audio src={track.src} trimBefore={track.trimBeforeFrames} volume={volume} />;
}

/** Hook textual deliberado: pequeno, no topo, separado da legenda falada. */
function Hook({ text, endFrame }: { text: string; endFrame: number }) {
  const frame = useCurrentFrame();
  const a = enter(frame, 6, 14);
  const out = interpolate(frame, [endFrame - 6, endFrame], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", top: SAFE_AREA.top + SPACE.md, left: SAFE_AREA.left, right: SAFE_AREA.right, display: "flex", justifyContent: "center", opacity: a.opacity * out, transform: `translateY(${a.translateY}px)` }}>
      <div style={{ color: COLORS.white, fontFamily: FONT.family, fontSize: 56, lineHeight: 1.08, fontWeight: FONT.weights.black, textAlign: "center", textShadow: "0 0 3px #000, 0 3px 10px rgba(0,0,0,0.6)" }}>{text}</div>
    </div>
  );
}

/** CTA editorial simples no topo: sem pill/card e longe da zona única de legenda. */
function CtaPill({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const a = enter(frame, 8, 18);
  // Lote 5.7: CTA pequeno, só opacidade (sem deslocamento), margens simétricas.
  return (
    <div style={{ position: "absolute", top: SAFE_AREA.top + 150, left: SAFE_AREA.right, right: SAFE_AREA.right, display: "flex", justifyContent: "center", opacity: a.opacity }}>
      <div style={{ color: COLORS.white, fontFamily: FONT.family, fontSize: 38, fontWeight: FONT.weights.heavy, padding: "6px 4px 8px", borderBottom: "4px solid #FFE14D", textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>
        {text}
      </div>
    </div>
  );
}

export function EditedCreative(props: CreativeProps) {
  const edit = props.edit!;
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, fontFamily: FONT.family }}>
      {edit.visuals.map((visual, i) => {
        // Crossfade legado / blend do Lote 6.2 (≤ 4 frames): o trecho anterior continua por baixo.
        const overlap = overlapFrames(edit.visuals[i + 1]);
        return (
          <Sequence key={visual.id} from={visual.startFrame} durationInFrames={Math.min(visual.durationFrames + overlap, props.durationInFrames - visual.startFrame)} name={`${visual.role === "aroll" ? "A-roll" : "B-roll"} ${i + 1}`}>
            <EditVisual visual={visual} />
          </Sequence>
        );
      })}
      {edit.hook && (
        <Sequence from={0} durationInFrames={edit.hook.endFrame} name="Hook">
          <Hook text={edit.hook.text} endFrame={edit.hook.endFrame} />
        </Sequence>
      )}
      {/* Caption V3 (Lote 5.7) para V2 e V3: âncora única, sem transform/rotação. */}
      <CaptionV3 captions={edit.captions} />
      {edit.cta && (
        <Sequence from={edit.cta.startFrame} durationInFrames={Math.max(1, edit.cta.endFrame - edit.cta.startFrame)} name="CTA">
          <CtaPill text={edit.cta.text} />
        </Sequence>
      )}
      {edit.audio.map((track, i) => (
        <Sequence key={`audio-${i}`} from={track.startFrame} durationInFrames={track.durationFrames} name={`Áudio A-roll ${i + 1}`} layout="none">
          <AudioTrack track={track} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
