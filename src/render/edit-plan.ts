import { EDIT_POLICY } from "@/config/edit-policy";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import {
  assertValidEditPlan,
  EDIT_PLAN_VERSION,
  EditPlanError,
  type ClipUsage,
  type EditAudioTrack,
  type AudioSilenceAnalysis,
  type EditCaption,
  type EditPlan,
  type EditVisualSegment,
} from "@/domain/edit";
import { nearestSilenceCut } from "./audio-silence";

/**
 * Creative Editor V2 (Lote 5.6) — função PURA: plano editorial + clipes gerados → Edit Plan.
 *
 * O MP4 NÃO é a concatenação das cenas. A timeline é a ESPINHA DE ÁUDIO dos A-rolls (cada clipe
 * Veo aparado pelos handles, em sequência, sem sobreposição: nunca duas vozes). B-rolls entram
 * como VISUAL por cima dessa espinha, numa junção entre A-rolls (parte sobre o fim do A-roll
 * anterior = L-cut, parte já sobre o áudio do próximo = J-cut), escondendo a emenda. B-roll nunca
 * toca áudio próprio; todo visual é mudo e o áudio vem só das faixas do plano.
 * Billing não muda: a janela usada é menor que a gerada, e o ledger continua pelo gerado.
 */

export interface EditClip {
  uri: string;
  /** Duração real medida do arquivo (ou a declarada pelo mock). */
  actualSeconds: number;
  /** Duração GERADA/cobrada (Veo 4/6/8s). */
  generatedSeconds: number;
  /** Pausas medidas no áudio real; ausente = análise indisponível, portanto nenhum corte automático. */
  audioSilence?: AudioSilenceAnalysis;
}

export interface BuildEditPlanInput {
  plan: Pick<CreativePlan, "scenes" | "hook" | "editPlanVersion">;
  /** sceneId → clipe ativo (A-rolls e B-roll gerado). */
  clips: ReadonlyMap<string, EditClip>;
  /** Frame de referência aprovado (B-roll `reference_detail`). */
  referenceImageUri?: string;
  /** Foto do produto (só B-roll `product_photo`, estilo comercial explícito). */
  productImageUri?: string;
  /** Texto do CTA pequeno (padrão: "Veja no carrinho"). */
  ctaLabel?: string;
  /** Hook textual deliberado; descartado se repetir a fala. */
  hookText?: string;
  policy?: typeof EDIT_POLICY;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const EPS = 1e-6;

interface ArollSpan {
  scene: ScenePlan;
  uri: string;
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  generated: number;
  audioSilence?: AudioSilenceAnalysis;
}

interface Overlay {
  scene: ScenePlan;
  start: number;
  end: number;
}

/** Janela usada de um clipe: descarta estabilização inicial e frames do fim; nunca menor que o mínimo. */
export function usableWindow(
  actualSeconds: number,
  handles: { headSeconds: number; tailSeconds: number },
  minUsable: number = EDIT_POLICY.minUsableSeconds,
  audioSilence?: AudioSilenceAnalysis,
): { sourceIn: number; sourceOut: number } {
  if (!(actualSeconds > 0)) throw new EditPlanError("Clipe sem duração.");
  const sourceIn = audioSilence
    ? nearestSilenceCut(audioSilence.intervals, handles.headSeconds, EDIT_POLICY.silence.cutToleranceSeconds) ?? 0
    : handles.headSeconds;
  const sourceOut = audioSilence
    ? nearestSilenceCut(audioSilence.intervals, actualSeconds - handles.tailSeconds, EDIT_POLICY.silence.cutToleranceSeconds) ?? actualSeconds
    : actualSeconds - handles.tailSeconds;
  if (sourceOut - sourceIn < minUsable) return { sourceIn: 0, sourceOut: r3(actualSeconds) };
  return { sourceIn: r3(sourceIn), sourceOut: r3(sourceOut) };
}

const cutIsSilent = (analysis: AudioSilenceAnalysis | undefined, seconds: number) =>
  analysis?.intervals.some(interval => interval.startSeconds - EPS <= seconds && interval.endSeconds + EPS >= seconds) ?? false;

const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Legenda V2: trechos de até 2 linhas, quebrando de preferência em pontuação; tempo proporcional aos caracteres. */
export function captionChunks(text: string, start: number, end: number, sceneId: string, policy = EDIT_POLICY): EditCaption[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || end - start < 0.3) return [];
  const maxChars = policy.caption.maxLines * policy.caption.maxCharsPerLine;
  const chunks: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (current.length > 0 && candidate.length > maxChars) { chunks.push(current.join(" ")); current = []; }
    current.push(word);
    if (/[.!?,;:]$/.test(word) && current.join(" ").length >= maxChars * 0.45) { chunks.push(current.join(" ")); current = []; }
  }
  if (current.length) chunks.push(current.join(" "));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  let cursor = start;
  return chunks.map((chunk) => {
    const duration = ((end - start) * chunk.length) / total;
    const caption: EditCaption = {
      text: chunk, sceneId, startSeconds: r3(cursor), endSeconds: r3(cursor + duration), timingSource: "estimated_from_script",
      // Poucos termos destacados: números/especificações (ex.: "2100W").
      emphasis: (chunk.match(/\b\d[\d.,]*\s?[a-zA-Z%°"]{0,4}\b/g) ?? []).slice(0, policy.caption.maxEmphasis),
    };
    cursor += duration;
    return caption;
  });
}

export function buildEditPlan(input: BuildEditPlanInput): EditPlan {
  const policy = input.policy ?? EDIT_POLICY;
  if (input.plan.editPlanVersion !== EDIT_PLAN_VERSION) throw new EditPlanError("Plano sem metadados editoriais (Editor V2).");
  const scenes = input.plan.scenes;
  if (scenes.some((s) => !s.edit)) throw new EditPlanError("Cena sem papel editorial (A-roll/B-roll).");

  // 1) Espinha de áudio: A-rolls aparados pelos handles, em sequência.
  const spans: ArollSpan[] = [];
  let cursor = 0;
  for (const scene of scenes.filter((s) => s.edit!.role === "aroll")) {
    const clip = input.clips.get(scene.id);
    if (!clip) throw new EditPlanError(`A-roll da cena ${scene.order + 1} sem clipe ativo.`);
    // A-roll sem medição local fica inteiro: é mais seguro manter respiração/cauda do que cortar fala.
    const { sourceIn, sourceOut } = clip.audioSilence
      ? usableWindow(clip.actualSeconds, policy.handles.aroll, policy.minUsableSeconds, clip.audioSilence)
      : { sourceIn: 0, sourceOut: r3(clip.actualSeconds) };
    const used = sourceOut - sourceIn;
    spans.push({ scene, uri: clip.uri, start: r3(cursor), end: r3(cursor + used), sourceIn, sourceOut, generated: clip.generatedSeconds,
      ...(clip.audioSilence ? { audioSilence: clip.audioSilence } : {}) });
    cursor += used;
  }
  if (spans.length === 0) throw new EditPlanError("Sem A-roll: o vídeo precisa da apresentadora.");
  const total = r3(cursor);
  const ctaStart = r3(Math.max(0, total - policy.ctaSeconds));

  // 2) B-roll overlays nas junções (L/J cut), respeitando A-roll visível e a janela do CTA.
  const overlays: Overlay[] = [];
  let lastAroll = -1;
  for (const scene of scenes) {
    if (scene.edit!.role === "aroll") { lastAroll = spans.findIndex((s) => s.scene.id === scene.id); continue; }
    const before = spans[lastAroll];
    const after = spans[lastAroll + 1];
    if (!before || !after) continue; // sem junção (antes do gancho ou depois do CTA): o A-roll continua
    let length = Math.min(Math.max(scene.duration, policy.broll.minSeconds),
      scene.edit!.brollKind === "reference_detail" || scene.edit!.brollKind === "product_photo" ? policy.broll.staticMaxSeconds : policy.broll.maxSeconds);
    const clip = scene.edit!.brollKind === "generated_context" ? input.clips.get(scene.id) : undefined;
    if (clip) {
      const window = usableWindow(clip.actualSeconds, policy.handles.broll, policy.broll.minSeconds);
      length = Math.min(length, window.sourceOut - window.sourceIn);
    }
    // Troca visual somente perto de pausa MEDIDA. Sem análise/pausa segura, permanece no A-roll.
    if (!before.audioSilence || !after.audioSilence) continue;
    const measuredPauses = [
      ...before.audioSilence.intervals.map(interval => ({
        startSeconds: before.start + Math.max(0, interval.startSeconds - before.sourceIn),
        endSeconds: before.start + Math.min(before.end - before.start, interval.endSeconds - before.sourceIn),
      })),
      ...after.audioSilence.intervals.map(interval => ({
        startSeconds: after.start + Math.max(0, interval.startSeconds - after.sourceIn),
        endSeconds: after.start + Math.min(after.end - after.start, interval.endSeconds - after.sourceIn),
      })),
    ].filter(interval => interval.endSeconds > interval.startSeconds);
    const junction = nearestSilenceCut(measuredPauses, before.end, policy.silence.cutToleranceSeconds);
    if (junction === undefined) continue;
    const earliest = before.start + policy.minArollVisibleSeconds;
    const latest = Math.min(after.end - policy.minArollVisibleSeconds, after === spans[spans.length - 1] ? ctaStart : Infinity);
    let start = Math.max(earliest, junction - length * policy.junctionTailShare);
    let end = Math.min(latest, start + length);
    start = Math.max(earliest, end - length);
    end = Math.min(latest, start + length);
    if (end - start + EPS < policy.broll.minSeconds) continue; // não cabe sem virar flicker: sem corte
    overlays.push({ scene, start: r3(start), end: r3(end) });
  }

  // 3) Visuais: A-roll visível onde não há overlay; cada trecho com motivo de corte.
  const breakpoints = [...new Set([0, total, ...spans.flatMap((s) => [s.start, s.end]), ...overlays.flatMap((o) => [o.start, o.end])].map(r3))].sort((a, b) => a - b);
  type Piece = { kind: "aroll"; span: ArollSpan; start: number; end: number } | { kind: "broll"; overlay: Overlay; start: number; end: number };
  const pieces: Piece[] = [];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const a = breakpoints[i]!;
    const b = breakpoints[i + 1]!;
    if (b - a < EPS) continue;
    const overlay = overlays.find((o) => o.start <= a + EPS && o.end >= b - EPS);
    const span = spans.find((s) => s.start <= a + EPS && s.end >= b - EPS)!;
    const previous = pieces[pieces.length - 1];
    if (overlay) {
      if (previous?.kind === "broll" && previous.overlay === overlay) previous.end = b;
      else pieces.push({ kind: "broll", overlay, start: a, end: b });
    } else if (previous?.kind === "aroll" && previous.span === span) previous.end = b;
    else pieces.push({ kind: "aroll", span, start: a, end: b });
  }

  const visuals: EditVisualSegment[] = [];
  const usage = new Map<string, ClipUsage>();
  let previousScale = 1;
  pieces.forEach((piece, index) => {
    const audioSceneIds = spans.filter(span => span.start < piece.end - EPS && span.end > piece.start + EPS).map(span => span.scene.id);
    const base = { id: `seg_${index + 1}`, startSeconds: r3(piece.start), endSeconds: r3(piece.end), muted: true as const,
      audioSceneId: audioSceneIds[0]!, audioSceneIds };
    if (piece.kind === "broll") {
      const edit = piece.overlay.scene.edit!;
      const length = piece.end - piece.start;
      const common = { ...base, role: "broll" as const, sceneId: piece.overlay.scene.id, cutReason: edit.cutReason, transition: edit.transition, continuityGroup: edit.continuityGroup, scale: 1 };
      if (edit.brollKind === "generated_context") {
        const clip = input.clips.get(piece.overlay.scene.id);
        if (!clip) throw new EditPlanError(`B-roll da cena ${piece.overlay.scene.order + 1} sem clipe ativo.`);
        const window = usableWindow(clip.actualSeconds, policy.handles.broll, policy.broll.minSeconds);
        visuals.push({ ...common, media: "video", uri: clip.uri, sourceInSeconds: window.sourceIn, sourceOutSeconds: r3(window.sourceIn + length) });
        usage.set(piece.overlay.scene.id, { sceneId: piece.overlay.scene.id, role: "broll", generatedSeconds: clip.generatedSeconds, usedSeconds: r3(length) });
      } else {
        const uri = edit.brollKind === "product_photo" ? input.productImageUri : input.referenceImageUri;
        if (!uri) throw new EditPlanError(`B-roll da cena ${piece.overlay.scene.order + 1} sem imagem de origem.`);
        visuals.push({ ...common, media: "image", uri, sourceInSeconds: 0, sourceOutSeconds: r3(length), ...(edit.crop ? { crop: edit.crop } : {}) });
      }
      previousScale = 1;
      return;
    }
    const { span } = piece;
    const edit = span.scene.edit!;
    const prev = pieces[index - 1];
    const crossfade = edit.transition === "crossfade"; // só quando o plano pede explicitamente
    let cutReason: EditVisualSegment["cutReason"];
    let transition: EditVisualSegment["transition"];
    let scale = 1;
    if (!prev) {
      cutReason = "opening"; transition = "straight_cut";
    } else if (prev.kind === "broll") {
      // Volta da apresentadora depois do detalhe: corte na ação (ou retorno do CTA).
      const firstOfClip = !pieces.slice(0, index).some((p) => p.kind === "aroll" && p.span === span);
      cutReason = firstOfClip && edit.cutReason === "cta_return" ? "cta_return" : "action_match";
      transition = crossfade ? "crossfade" : "cut_on_action";
    } else {
      // Junção DIRETA entre dois A-rolls do mesmo enquadramento: fronteira de frase + punch-in sutil
      // alternado (esconde o jump cut sem zoom de template).
      cutReason = edit.cutReason === "cta_return" ? "cta_return" : "sentence_boundary";
      transition = crossfade ? "crossfade" : "punch_in";
      scale = previousScale > 1 ? 1 : policy.punchInScale;
    }
    previousScale = scale;
    const sourceIn = r3(span.sourceIn + (piece.start - span.start));
    visuals.push({
      ...base, role: "aroll", sceneId: span.scene.id, media: "video", uri: span.uri,
      sourceInSeconds: sourceIn, sourceOutSeconds: r3(sourceIn + (piece.end - piece.start)),
      cutReason, transition, continuityGroup: edit.continuityGroup, scale,
    });
  });

  // 4) Áudio: uma faixa por A-roll, em sequência, com micro fades anti-pop.
  const audio: EditAudioTrack[] = spans.map((span, i) => ({
    sceneId: span.scene.id, uri: span.uri, startSeconds: span.start, endSeconds: span.end,
    sourceInSeconds: span.sourceIn, sourceOutSeconds: span.sourceOut, gain: 1,
    fadeInSeconds: i > 0 && cutIsSilent(span.audioSilence, span.sourceIn) ? policy.audioFadeSeconds : 0,
    fadeOutSeconds: cutIsSilent(span.audioSilence, span.sourceOut) ? policy.audioFadeSeconds : 0,
  }));
  for (const span of spans) usage.set(span.scene.id, { sceneId: span.scene.id, role: "aroll", generatedSeconds: span.generated, usedSeconds: r3(span.sourceOut - span.sourceIn) });

  // 5) Legendas: uma zona, pela fala de cada A-roll dentro da janela usada.
  const captions = spans.flatMap((span) => captionChunks(span.scene.narration, span.start + 0.05, span.end - 0.1, span.scene.id, policy));

  // 6) Hook textual só quando é deliberado (não repete a fala); CTA pequeno sobre a apresentadora.
  const hookText = input.hookText?.trim();
  const firstSpeech = normalize(spans[0]!.scene.narration);
  const hook = hookText && !firstSpeech.includes(normalize(hookText)) ? { text: hookText, endSeconds: r3(Math.min(policy.hookMaxSeconds, spans[0]!.end)) } : undefined;
  const lastVisual = visuals[visuals.length - 1]!;
  const cta = { text: input.ctaLabel?.trim() || policy.ctaLabel, startSeconds: ctaStart, endSeconds: total, overPresenter: lastVisual.role === "aroll" && lastVisual.startSeconds <= ctaStart + EPS };

  return assertValidEditPlan({
    version: EDIT_PLAN_VERSION, durationSeconds: total, visuals, audio, captions,
    ...(hook ? { hook } : {}), cta,
    usage: [...usage.values()],
  });
}
