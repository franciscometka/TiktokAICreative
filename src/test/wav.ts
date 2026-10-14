/** WAV PCM 16-bit mono gerado em memória (tom senoidal) — fixture LOCAL de áudio, sem TTS. */
export function makeWav(seconds: number, options: { sampleRate?: number; frequency?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 22_050;
  const frequency = options.frequency ?? 440;
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 400, (samples - i) / 400); // sem estalo no começo/fim
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 9000 * fade), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // tamanho do bloco fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits por amostra
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
