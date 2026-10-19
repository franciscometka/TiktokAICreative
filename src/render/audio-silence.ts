import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioSilenceAnalysis, AudioSilenceInterval } from "@/domain/edit";

const execute = promisify(execFile);

const r3 = (value: number) => Math.round(value * 1000) / 1000;

/** Converte somente os eventos do FFmpeg; não infere palavras nem fala. */
export function parseSilenceDetect(output: string, durationSeconds: number): AudioSilenceInterval[] {
  const intervals: AudioSilenceInterval[] = [];
  let start: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([\d.]+)/.exec(line);
    if (startMatch) start = Number(startMatch[1]);
    const endMatch = /silence_end:\s*([\d.]+)/.exec(line);
    if (endMatch && start !== undefined) {
      const end = Math.min(durationSeconds, Number(endMatch[1]));
      if (Number.isFinite(end) && end > start) intervals.push({ startSeconds: r3(start), endSeconds: r3(end) });
      start = undefined;
    }
  }
  if (start !== undefined && durationSeconds > start) intervals.push({ startSeconds: r3(start), endSeconds: r3(durationSeconds) });
  return intervals;
}

/** Ponto central da pausa mais próxima, desde que esteja dentro da tolerância editorial. */
export function nearestSilenceCut(intervals: readonly AudioSilenceInterval[], targetSeconds: number, toleranceSeconds: number): number | undefined {
  return intervals
    .map(interval => ({ cut: (interval.startSeconds + interval.endSeconds) / 2, distance: Math.abs((interval.startSeconds + interval.endSeconds) / 2 - targetSeconds) }))
    .filter(candidate => candidate.distance <= toleranceSeconds)
    .sort((a, b) => a.distance - b.distance || a.cut - b.cut)[0]?.cut;
}

/** Análise determinística e offline. Falha local só desabilita cortes automáticos; nunca bloqueia a mídia. */
export async function analyzeAudioSilence(path: string, durationSeconds: number, options: { noiseDb: number; minSeconds: number }): Promise<AudioSilenceAnalysis | undefined> {
  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const ffmpeg = RenderInternals.getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error", binariesDirectory: null });
    const { stderr } = await execute(ffmpeg, [
      "-hide_banner", "-nostats", "-i", path, "-vn",
      "-af", `silencedetect=noise=${options.noiseDb}dB:d=${options.minSeconds}`,
      "-f", "null", "-",
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return {
      source: "ffmpeg_silencedetect",
      noiseDb: options.noiseDb,
      minSilenceSeconds: options.minSeconds,
      intervals: parseSilenceDetect(stderr, durationSeconds),
    };
  } catch {
    return undefined;
  }
}
