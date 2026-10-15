/** Inspect PCM WAV chunks, including FFmpeg LIST metadata. */
export function presenterWavDuration(input: Uint8Array): number {
  const b = Buffer.from(input);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("WAV PCM inválido.");
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= b.length;) {
    const type = b.toString("ascii", offset, offset + 4);
    const length = b.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + length > b.length) throw new Error("WAV incompleto.");
    if (type === "fmt ") {
      if (length < 16 || b.readUInt16LE(start) !== 1 || b.readUInt16LE(start + 2) !== 1 || b.readUInt32LE(start + 4) !== 16000 || b.readUInt16LE(start + 14) !== 16) throw new Error("WAV deve ser PCM mono 16kHz/16-bit.");
      byteRate = b.readUInt32LE(start + 8);
      if (byteRate !== 32000) throw new Error("Taxa WAV inválida.");
    }
    if (type === "data" && byteRate && length > 0) return length / byteRate;
    offset = start + length + length % 2;
  }
  throw new Error("WAV sem áudio PCM.");
}
