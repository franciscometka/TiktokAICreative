import { PRESENTER_POLICY } from "@/config/edit-policy";
import type { CreativePlan } from "@/domain/creative";
import {
  assertValidEditPlan,
  EditPlanError,
  PRESENTER_EDIT_PLAN_VERSION,
  type AudioSilenceInterval,
  type EditAudioTrack,
  type EditCaption,
  type EditPlan,
  type EditVisualSegment,
} from "@/domain/edit";
import type { EditClip } from "./edit-plan";
import { chooseTransition, continuitySide } from "./natural-transitions";

/**
 * Edit Plan V3 — Presenter Only (Lote 5.7). Função PURA: A-rolls da apresentadora → timeline.
 *
 *   A-roll 1 → A-roll 2 → … → A-roll N (nenhum segmento visual estático, nenhum B-roll/card).
 *
 * Determinismo: TODO tempo é um número inteiro de frames (`fps`) e convertido uma única vez; o
 * cursor da timeline anda em frames, então não há erro acumulado nem 1 frame de lacuna/sobreposição
 * nas junções (a causa provável das "travadas" de áudio). Áudio e visual de cada trecho usam a
 * MESMA janela; uma faixa de áudio por vez, contígua.
 *
 * Handles adaptativos: só corta DENTRO de pausa medida (silencedetect) na borda do clipe, deixando
 * respiro; fala encostada na borda não é cortada. Sem medição, o clipe entra inteiro. O último
 * trecho mantém 0,8–1,2s de vídeo natural depois da última palavra (nunca corta na última sílaba).
 */

export interface BuildPresenterEditPlanInput {
  plan: Pick<CreativePlan, "scenes" | "editPlanVersion">;
  clips: ReadonlyMap<string, EditClip>;
  ctaLabel?: string;
  policy?: typeof PRESENTER_POLICY;
}

const EDGE = 0.05;

interface Span {
  sceneId: string;
  uri: string;
  speech: string;
  inF: number;
  outF: number;
  startF: number;
  generated: number;
  /** Corte de entrada/saída caiu dentro de pausa medida. */
  leadSilent: boolean;
  trailSilent: boolean;
  /** Fim da fala medida (tempo do clipe), quando há pausa final. */
  speechEndSeconds?: number;
  pauses: AudioSilenceInterval[];
  measured: boolean;
  continuity?: NonNullable<CreativePlan["scenes"][number]["edit"]>["continuity"];
  /** Frames de mídia disponíveis no clipe (para blend sem congelar o último frame). */
  mediaF: number;
}

/** Janela adaptativa (segundos do clipe), antes da quantização. */
export function presenterWindow(clip: EditClip, last: boolean, policy = PRESENTER_POLICY) {
  const actual = clip.actualSeconds;
  if (!(actual > 0)) throw new EditPlanError("Clipe sem duração.");
  const intervals = clip.audioSilence?.intervals ?? [];
  if (!clip.audioSilence) return { sourceIn: 0, sourceOut: actual, leadSilent: false, trailSilent: false, speechEnd: undefined as number | undefined };
  const lead = intervals.find((i) => i.startSeconds <= EDGE && i.endSeconds > EDGE);
  const trail = intervals.find((i) => i.endSeconds >= actual - EDGE && i.startSeconds < actual - EDGE);
  const sourceIn = lead ? Math.max(0, lead.endSeconds - policy.handles.keepLeadSilenceSeconds) : 0;
  let sourceOut = actual;
  if (trail) {
    sourceOut = last
      ? Math.min(actual, trail.startSeconds + policy.finalTail.maxSeconds)
      : Math.min(actual, trail.startSeconds + policy.handles.keepTrailSilenceSeconds);
  }
  return { sourceIn, sourceOut, leadSilent: !!lead, trailSilent: !!trail, speechEnd: trail?.startSeconds };
}

/** Frases curtas do roteiro, até 2 linhas, quebrando em pontuação. */
export function captionPhrases(text: string, policy = PRESENTER_POLICY): string[] {
  const maxChars = policy.caption.maxLines * policy.caption.maxCharsPerLine;
  const out: string[] = [];
  for (const sentence of text.trim().split(/(?<=[.!?;:,])\s+/).filter(Boolean)) {
    let current: string[] = [];
    for (const word of sentence.split(/\s+/)) {
      if (current.length && [...current, word].join(" ").length > maxChars) { out.push(current.join(" ")); current = []; }
      current.push(word);
    }
    if (current.length) out.push(current.join(" "));
  }
  // Junta frase muito curta (ex.: "Olha.") com a seguinte quando cabe em 2 linhas.
  const merged: string[] = [];
  for (const phrase of out) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length < 12 && `${previous} ${phrase}`.length <= maxChars) merged[merged.length - 1] = `${previous} ${phrase}`;
    else merged.push(phrase);
  }
  return merged;
}

/** Quebra a frase em até 2 linhas equilibradas (largura máxima consistente). */
export function captionLines(text: string, policy = PRESENTER_POLICY): string[] {
  const words = text.split(/\s+/);
  if (text.length <= policy.caption.maxCharsPerLine || words.length < 2) return [text];
  let best: [string, string] = [text, ""];
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const s = Math.max(a.length, b.length);
    if (s < score) { score = s; best = [a, b]; }
  }
  return best;
}

/**
 * Timing V3 das legendas: as frases do roteiro são distribuídas sobre os intervalos de FALA medidos
 * (o complemento das pausas), proporcionalmente aos caracteres; o "relógio de fala" pula as pausas,
 * então a troca de legenda tende a cair na pausa e nunca no meio de uma palavra medida. Sem ASR.
 */
function captionsFor(span: Span, fps: number, policy: typeof PRESENTER_POLICY): EditCaption[] {
  const phrases = captionPhrases(span.speech, policy);
  if (phrases.length === 0) return [];
  const clipIn = span.inF / fps;
  const clipOut = span.outF / fps;
  const speechEnd = span.speechEndSeconds !== undefined ? Math.min(clipOut, span.speechEndSeconds) : clipOut - 0.1;
  const pauses = span.pauses.filter((p) => p.endSeconds > clipIn && p.startSeconds < speechEnd).map((p) => ({ start: Math.max(clipIn, p.startSeconds), end: Math.min(speechEnd, p.endSeconds) }));
  const speech: { start: number; end: number }[] = [];
  let at = span.measured ? clipIn : clipIn + 0.05;
  for (const p of pauses.sort((a, b) => a.start - b.start)) {
    if (p.start > at) speech.push({ start: at, end: p.start });
    at = Math.max(at, p.end);
  }
  if (speechEnd > at) speech.push({ start: at, end: speechEnd });
  const talk = speech.reduce((s, i) => s + (i.end - i.start), 0);
  if (talk <= 0) return [];
  const totalChars = phrases.reduce((s, p) => s + p.length, 0);
  // relógio de fala (s de fala) → tempo do clipe
  const toClip = (t: number) => {
    let left = t;
    for (const i of speech) { const len = i.end - i.start; if (left <= len + 1e-9) return i.start + left; left -= len; }
    return speech[speech.length - 1]!.end;
  };
  const boundaries = [0];
  let acc = 0;
  for (const p of phrases) { acc += (talk * p.length) / totalChars; boundaries.push(acc); }
  const toTimeline = (clipSeconds: number) => Math.round((span.startF + (clipSeconds - clipIn) * fps)) / fps;
  const captions: EditCaption[] = [];
  phrases.forEach((text, i) => {
    let start = toClip(boundaries[i]!);
    let end = toClip(boundaries[i + 1]!);
    // Se a fronteira caiu logo antes de uma pausa, a legenda fica até o fim da pausa (troca no silêncio).
    const pauseAfter = pauses.find((p) => p.start >= end - 0.02 && p.start - end < 0.25);
    if (pauseAfter && i < phrases.length - 1) end = pauseAfter.end;
    if (i === 0) start = Math.max(clipIn, start);
    const startS = toTimeline(start);
    const endS = Math.max(startS + 1 / fps, toTimeline(end));
    captions.push({ text, startSeconds: startS, endSeconds: endS, sceneId: span.sceneId, timingSource: span.measured ? "mapped_to_audio_pauses" : "estimated_from_script",
      emphasis: (text.match(/\b\d[\d.,]*\s?[a-zA-Z%°"]{0,4}\b/g) ?? []).slice(0, policy.caption.maxEmphasis) });
  });
  // Sem sobreposição entre legendas consecutivas.
  for (let i = 1; i < captions.length; i++) if (captions[i]!.startSeconds < captions[i - 1]!.endSeconds) captions[i - 1]!.endSeconds = captions[i]!.startSeconds;
  return captions.filter((c) => c.endSeconds > c.startSeconds);
}

export function buildPresenterEditPlan(input: BuildPresenterEditPlanInput): EditPlan {
  const policy = input.policy ?? PRESENTER_POLICY;
  const fps = policy.fps;
  if (input.plan.editPlanVersion !== PRESENTER_EDIT_PLAN_VERSION) throw new EditPlanError("Plano não é Presenter Only (V3).");
  const scenes = input.plan.scenes.filter((s) => s.edit?.role === "aroll");
  if (scenes.length !== input.plan.scenes.length) throw new EditPlanError("Presenter Only não aceita B-roll/imagem: só trechos da apresentadora.");
  if (scenes.length === 0) throw new EditPlanError("Sem trechos da apresentadora.");
  const warnings: string[] = [];
  const spans: Span[] = [];
  let cursorF = 0;
  scenes.forEach((scene, i) => {
    const clip = input.clips.get(scene.id);
    if (!clip) throw new EditPlanError(`Trecho ${i + 1} sem clipe ativo.`);
    const last = i === scenes.length - 1;
    const w = presenterWindow(clip, last, policy);
    // Entrada arredonda para o frame mais próximo; saída para BAIXO (nunca além da mídia).
    let inF = Math.round(w.sourceIn * fps);
    let outF = Math.floor(w.sourceOut * fps + 1e-6);
    if (outF - inF < Math.round(1.5 * fps)) { inF = 0; outF = Math.floor(clip.actualSeconds * fps + 1e-6); }
    spans.push({ sceneId: scene.id, uri: clip.uri, speech: scene.narration, inF, outF, startF: cursorF, generated: clip.generatedSeconds,
      leadSilent: w.leadSilent && inF > 0, trailSilent: w.trailSilent, ...(w.speechEnd !== undefined ? { speechEndSeconds: w.speechEnd } : {}),
      pauses: clip.audioSilence?.intervals ?? [], measured: !!clip.audioSilence, continuity: scene.edit?.continuity, mediaF: Math.floor(clip.actualSeconds * fps + 1e-6) });
    cursorF += outF - inF;
  });
  const totalF = cursorF;
  const s = (f: number) => f / fps;

  const visuals: EditVisualSegment[] = [];
  const audio: EditAudioTrack[] = [];
  let scale = 1;
  const fade = Math.round(0.06 * fps) / fps;
  spans.forEach((span, i) => {
    const last = i === spans.length - 1;
    const previous = spans[i - 1];
    const pausedCut = !!previous && (previous.trailSilent || span.leadSilent);
    // Lote 6.2 — Natural Transition Engine: match cut > cut on action > micro punch > blur > dissolve.
    // Só VISUAL e só na junção (fim de frase/pausa medida); o áudio abaixo continua contíguo.
    const transitionSpec = previous ? chooseTransition({
      previous: continuitySide(previous.continuity), next: continuitySide(span.continuity),
      previousScale: scale, previousSpareFrames: previous.mediaF - previous.outF,
    }) : undefined;
    scale = !transitionSpec ? 1 : transitionSpec.punch ? transitionSpec.punch.toScale : scale;
    const endF = span.startF + span.outF - span.inF;
    const tail = last && span.speechEndSeconds !== undefined ? Math.max(0, span.outF / fps - span.speechEndSeconds) : undefined;
    visuals.push({
      id: `seg_${i + 1}`, startSeconds: s(span.startF), endSeconds: s(endF), role: "aroll", sceneId: span.sceneId, media: "video", uri: span.uri,
      sourceInSeconds: s(span.inF), sourceOutSeconds: s(span.outF), muted: true,
      cutReason: i === 0 ? "opening" : pausedCut ? "natural_pause" : "sentence_boundary",
      transition: transitionSpec?.type ?? "straight_cut",
      ...(transitionSpec ? { transitionSpec } : {}),
      continuityGroup: "presenter", scale, audioSceneId: span.sceneId, audioSceneIds: [span.sceneId],
      speech: span.speech, pauseBoundaries: span.pauses.filter((p) => p.endSeconds > s(span.inF) && p.startSeconds < s(span.outF)),
      ...(span.continuity ? { continuity: span.continuity } : {}),
      ...(tail !== undefined ? { finalTailSeconds: Math.round(tail * 1000) / 1000 } : {}),
    });
    // Fade de 2 frames SÓ quando o corte está dentro de pausa medida (nunca sobre palavra).
    audio.push({ sceneId: span.sceneId, uri: span.uri, startSeconds: s(span.startF), endSeconds: s(endF), sourceInSeconds: s(span.inF), sourceOutSeconds: s(span.outF), gain: 1,
      fadeInSeconds: i > 0 && span.leadSilent ? fade : 0,
      fadeOutSeconds: (last ? span.speechEndSeconds !== undefined : span.trailSilent) ? fade : 0 });
  });

  const lastSpan = spans[spans.length - 1]!;
  const finalTail = lastSpan.speechEndSeconds !== undefined ? Math.round((lastSpan.outF / fps - lastSpan.speechEndSeconds) * 1000) / 1000 : undefined;
  if (finalTail === undefined) warnings.push(lastSpan.measured ? "A fala do último trecho encosta no fim do clipe: cauda natural indisponível." : "Último trecho sem análise de áudio: cauda natural não medida.");
  else if (finalTail + 1e-6 < policy.finalTail.minSeconds) warnings.push(`Cauda final de ${finalTail}s, abaixo de ${policy.finalTail.minSeconds}s: o clipe não tem mais vídeo depois da última palavra.`);
  if (s(totalF) < policy.minFinalSeconds) warnings.push(`Duração final ${s(totalF).toFixed(1)}s abaixo de ${policy.minFinalSeconds}s: a fala gerada ficou curta.`);

  const captions = spans.flatMap((span) => captionsFor(span, fps, policy));
  const ctaText = input.ctaLabel?.trim();
  const ctaStartF = Math.max(0, totalF - Math.round(policy.ctaOverlaySeconds * fps));
  return assertValidEditPlan({
    version: PRESENTER_EDIT_PLAN_VERSION, fps, durationSeconds: s(totalF), visuals, audio, captions,
    ...(ctaText ? { cta: { text: ctaText, startSeconds: s(ctaStartF), endSeconds: s(totalF), overPresenter: true } } : {}),
    ...(finalTail !== undefined ? { finalTailSeconds: finalTail } : {}),
    warnings,
    usage: spans.map((span) => ({ sceneId: span.sceneId, role: "aroll" as const, generatedSeconds: span.generated, usedSeconds: s(span.outF - span.inF) })),
  });
}

/**
 * Validação pós-edição (Lote 5.7): reporta, sem lançar, problemas mensuráveis da timeline —
 * lacuna, sobreposição, duração divergente, faixa de áudio fora da grade de frames.
 */
export function auditEditTimeline(plan: EditPlan): string[] {
  const issues: string[] = [];
  try { assertValidEditPlan(plan); } catch (error) { issues.push(error instanceof Error ? error.message : "Edit Plan inválido."); }
  const audio = [...plan.audio].sort((a, b) => a.startSeconds - b.startSeconds);
  for (let i = 1; i < audio.length; i++) {
    const gap = audio[i]!.startSeconds - audio[i - 1]!.endSeconds;
    if (gap > 1e-6) issues.push(`Lacuna de áudio de ${(gap * 1000).toFixed(0)}ms antes do trecho ${i + 1}.`);
    if (gap < -1e-6) issues.push(`Sobreposição de áudio de ${(-gap * 1000).toFixed(0)}ms no trecho ${i + 1}.`);
  }
  const lastAudio = audio[audio.length - 1];
  if (lastAudio && Math.abs(lastAudio.endSeconds - plan.durationSeconds) > 1e-6) issues.push("Áudio termina antes/depois do vídeo.");
  return issues;
}
