/**
 * Duração de um MP3 pelos cabeçalhos dos frames (MPEG-1/2/2.5 Layer III), sem dependência.
 * Pula tag ID3v2 no início. Soma frame a frame (funciona para CBR e VBR).
 */

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = (((b[6] ?? 0) & 0x7f) << 21) | (((b[7] ?? 0) & 0x7f) << 14) | (((b[8] ?? 0) & 0x7f) << 7) | ((b[9] ?? 0) & 0x7f);
  return 10 + size;
}

export function isMp3(b: Uint8Array): boolean {
  if (id3Size(b) > 0) return true;
  return b.length > 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0;
}

export function mp3DurationSeconds(b: Uint8Array): number | undefined {
  let o = id3Size(b);
  let seconds = 0;
  let frames = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xe0) !== 0xe0) {
      o += 1;
      continue;
    }
    const versionBits = ((b[o + 1] ?? 0) >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = ((b[o + 1] ?? 0) >> 1) & 0x03; // 1 = Layer III
    const bitrateIndex = ((b[o + 2] ?? 0) >> 4) & 0x0f;
    const rateIndex = ((b[o + 2] ?? 0) >> 2) & 0x03;
    const padding = ((b[o + 2] ?? 0) >> 1) & 0x01;
    const rates = SAMPLE_RATES[versionBits];
    if (versionBits === 1 || layerBits !== 1 || !rates || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) {
      o += 1;
      continue;
    }
    const mpeg1 = versionBits === 3;
    const kbps = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] ?? 0;
    const sampleRate = rates[rateIndex] ?? 44100;
    const samples = mpeg1 ? 1152 : 576;
    const frameLength = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / sampleRate) + padding;
    if (frameLength < 4) break;
    seconds += samples / sampleRate;
    frames += 1;
    o += frameLength;
  }
  return frames > 0 ? Math.round(seconds * 1000) / 1000 : undefined;
}
