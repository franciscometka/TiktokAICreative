import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PRESENTER_POLICY } from "@/config/edit-policy";

const execute = promisify(execFile);

/** Leitura local (ffprobe do Remotion) do MP4 final. Sem rede. */
export interface RenderedMediaProbe {
  durationSeconds: number;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; sampleRate: number; channels: number; durationSeconds?: number };
}

interface FfprobeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number; duration?: string }

/** Converte a saída JSON do ffprobe (função pura, testável sem binário). */
export function parseFfprobe(json: string): RenderedMediaProbe {
  const data = JSON.parse(json) as { streams?: FfprobeStream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSeconds: Number(data.format?.duration ?? 0),
    ...(v ? { video: { codec: v.codec_name ?? "", width: v.width ?? 0, height: v.height ?? 0, fps: den ? num! / den : 0 } } : {}),
    ...(a ? { audio: { codec: a.codec_name ?? "", sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0, ...(a.duration ? { durationSeconds: Number(a.duration) } : {}) } } : {}),
  };
}

/**
 * Validação pós-render (Lote 5.7): formato de áudio consistente (AAC 48 kHz estéreo), duração do
 * arquivo = duração planejada (±1 frame + folga do container) e trilha de áudio do tamanho do vídeo
 * (sem lacuna/corte no fim). Devolve problemas; não lança.
 */
export function validateRenderedMedia(probe: RenderedMediaProbe, expected: { durationSeconds: number; hasAudio: boolean; fps: number }): string[] {
  const issues: string[] = [];
  const tolerance = 1 / expected.fps + 0.05;
  if (Math.abs(probe.durationSeconds - expected.durationSeconds) > tolerance) issues.push(`Duração do MP4 ${probe.durationSeconds.toFixed(3)}s difere da planejada ${expected.durationSeconds.toFixed(3)}s.`);
  if (!expected.hasAudio) return issues;
  const want = PRESENTER_POLICY.audio;
  if (!probe.audio) return [...issues, "MP4 sem trilha de áudio."];
  if (probe.audio.codec !== want.codec) issues.push(`Áudio ${probe.audio.codec}, esperado ${want.codec}.`);
  if (probe.audio.sampleRate !== want.sampleRate) issues.push(`Áudio a ${probe.audio.sampleRate} Hz, esperado ${want.sampleRate} Hz.`);
  if (probe.audio.channels !== want.channels) issues.push(`Áudio com ${probe.audio.channels} canais, esperado ${want.channels}.`);
  if (probe.audio.durationSeconds !== undefined && Math.abs(probe.audio.durationSeconds - expected.durationSeconds) > tolerance + 0.05) {
    issues.push(`Trilha de áudio ${probe.audio.durationSeconds.toFixed(3)}s ≠ vídeo ${expected.durationSeconds.toFixed(3)}s.`);
  }
  return issues;
}

export async function probeRenderedMedia(path: string): Promise<RenderedMediaProbe | undefined> {
  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const ffprobe = RenderInternals.getExecutablePath({ type: "ffprobe", indent: false, logLevel: "error", binariesDirectory: null });
    const { stdout } = await execute(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return parseFfprobe(stdout);
  } catch {
    return undefined;
  }
}

/** Lote 7 (worker:check): o FFmpeg empacotado pelo Remotion executa neste ambiente? Sem rede. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const ffmpeg = RenderInternals.getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error", binariesDirectory: null });
    await execute(ffmpeg, ["-version"], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
