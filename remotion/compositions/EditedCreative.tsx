import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import { GeneratedVideoPlaceholder } from "../components/GeneratedVideoPlaceholder";
import { enter } from "../styles/animation";
import { CANVAS, COLORS, FONT, LAYOUT, MOTION, SAFE_AREA, SPACE } from "../styles/theme";
import type { CreativeProps, EditAudioProps, EditProps, EditVisualProps } from "../types/props";

/**
 * Creative Editor V2 (Lote 5.6): UM vídeo contínuo. A-roll é a base; B-roll entra por cima do
 * áudio do A-roll. Todo visual é MUDO; o áudio vem só das faixas do Edit Plan (fala nativa do
 * A-roll), com trim e micro fades. Sem zooms de template, sem card final, sem barra de progresso.
 */

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function EditVisual({ visual }: { visual: EditVisualProps }) {
  const frame = useCurrentFrame();
  // Crossfade só quando o plano pediu explicitamente; o resto é corte seco.
  const opacity = visual.transition === "crossfade" ? interpolate(frame, [0, MOTION.crossfadeFrames], [0, 1], clamp) : 1;
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
      <OffthreadVideo
        src={visual.src}
        muted
        trimBefore={visual.trimBeforeFrames}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${visual.scale})`, transformOrigin: "50% 42%" }}
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

function emphasize(text: string, emphasis: readonly string[]) {
  if (emphasis.length === 0) return text;
  const pattern = new RegExp(`(${emphasis.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(pattern).map((part, i) => (emphasis.includes(part) ? <span key={i} style={{ color: "#FFE14D" }}>{part}</span> : part));
}

/** Legenda V2: UMA zona, até 2 linhas, texto com contorno (sem barra gigante), dentro da safe area. */
function Captions({ captions }: { captions: EditProps["captions"] }) {
  const frame = useCurrentFrame();
  const current = captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!current) return null;
  const opacity = interpolate(frame - current.startFrame, [0, 3], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: SAFE_AREA.left, right: SAFE_AREA.right, bottom: CANVAS.height - LAYOUT.captionBottom, display: "flex", justifyContent: "center", opacity }}>
      <div
        style={{
          color: COLORS.white, fontFamily: FONT.family, fontSize: 52, lineHeight: 1.16, fontWeight: FONT.weights.heavy, letterSpacing: -0.3,
          textAlign: "center", textShadow: "0 0 3px #000, 0 2px 4px rgba(0,0,0,0.85), 0 0 14px rgba(0,0,0,0.45)",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "break-word",
        }}
      >
        {emphasize(current.text, current.emphasis)}
      </div>
    </div>
  );
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
  return (
    <div style={{ position: "absolute", top: SAFE_AREA.top + 150, left: SAFE_AREA.left, right: SAFE_AREA.right, display: "flex", justifyContent: "center", opacity: a.opacity, transform: `translateY(${a.translateY}px)` }}>
      <div style={{ color: COLORS.white, fontFamily: FONT.family, fontSize: 42, fontWeight: FONT.weights.heavy, padding: "6px 4px 8px", borderBottom: "4px solid #FFE14D", textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>
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
        // Crossfade (exceção): o trecho anterior continua por baixo por poucos frames.
        const next = edit.visuals[i + 1];
        const overlap = next?.transition === "crossfade" ? MOTION.crossfadeFrames : 0;
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
      <Captions captions={edit.captions} />
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
