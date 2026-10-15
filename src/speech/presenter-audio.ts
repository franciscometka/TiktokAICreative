import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativePlan } from "@/domain/creative";
import type { NarrationTiming } from "@/domain/audio";
import { presenterBilledSeconds } from "@/config/presenters";
const execute = promisify(execFile);
export interface AudioWindow { startSeconds: number; endSeconds: number }
/** All scene boundaries follow the real speech; silence until the next scene stays in this clip. */
export function alignedSceneWindows(plan: CreativePlan, timing: NarrationTiming, duration: number): AudioWindow[] {
  const windows = plan.scenes.map(s => timing.scenes.find(w => w.sceneId === s.id));
  if (windows.some(w => !w || w.endSeconds <= w.startSeconds)) throw new Error("Presenter exige alignment real e fala em todas as cenas; revise a narração.");
  const starts = windows.map((w, i) => i === 0 ? 0 : w!.startSeconds);
  return starts.map((startSeconds, i) => {
    const endSeconds = starts[i + 1] ?? duration;
    if (endSeconds <= startSeconds || windows[i]!.endSeconds > endSeconds + 0.05 || endSeconds > duration + 0.05) throw new Error("Alignment de cenas inconsistente; nenhuma chamada de presenter enviada.");
    return { startSeconds, endSeconds };
  });
}
export function alignedPresenterPlan(plan: CreativePlan, timing: NarrationTiming, duration: number): CreativePlan {
  const windows = alignedSceneWindows(plan, timing, duration);
  return { ...plan, duration, scenes: plan.scenes.map((scene, i) => ({ ...scene, duration: windows[i]!.endSeconds - windows[i]!.startSeconds, transition: "cut" })) };
}
export type AudioSlicer = (path: string, window: AudioWindow) => Promise<Uint8Array>;
/** Decode and re-encode PCM: accurate cuts instead of MP3 packet seeking. Local only. */
export const slicePresenterAudio: AudioSlicer = async (path, window) => {
  presenterBilledSeconds(window.endSeconds - window.startSeconds);
  const { RenderInternals } = await import("@remotion/renderer");
  const ffmpeg = RenderInternals.getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error", binariesDirectory: null });
  const dir = await mkdtemp(join(tmpdir(), "presenter-audio-"));
  try {
    const target = join(dir, "speech.wav");
    await execute(ffmpeg, ["-v", "error", "-i", path, "-ss", String(window.startSeconds), "-t", String(window.endSeconds - window.startSeconds), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", target], { timeout: 30_000, windowsHide: true });
    return new Uint8Array(await readFile(target));
  } catch { throw new Error("Não foi possível recortar a narração local; nenhuma chamada de presenter enviada."); }
  finally { await rm(dir, { recursive: true, force: true }); }
};
