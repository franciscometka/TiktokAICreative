/**
 * MP4 mínimo para testes offline: ftyp + mdat + moov(mvhd + trak/mdia(mdhd + hdlr)).
 * A duração da trilha (mdhd) e a do filme (mvhd) podem divergir para simular metadata incoerente.
 */
function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const length = 8 + payloads.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let o = 8;
  for (const p of payloads) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function header(seconds: number, size: number, timescaleAt: number): Uint8Array {
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  view.setUint32(timescaleAt, 1000);
  view.setUint32(timescaleAt + 4, Math.round(seconds * 1000));
  return payload;
}

export function makeMp4(seconds: number, options: { movieSeconds?: number; videoTrack?: boolean; mdatBytes?: number; audioTrack?: boolean } = {}): Uint8Array {
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\x02\0isomavc1"));
  const mdat = box("mdat", new Uint8Array(options.mdatBytes ?? 64));
  const mvhd = box("mvhd", header(options.movieSeconds ?? seconds, 100, 12));
  const hdlr = box("hdlr", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(options.videoTrack === false ? "soun" : "vide"), ...new Uint8Array(13)]));
  const mdhd = box("mdhd", header(seconds, 24, 12));
  const soun = box("hdlr", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode("soun"), ...new Uint8Array(13)]));
  const audio = options.audioTrack ? [box("trak", box("mdia", box("mdhd", header(seconds, 24, 12)), soun))] : [];
  const moov = box("moov", mvhd, box("trak", box("mdia", mdhd, hdlr)), ...audio);
  const out = new Uint8Array(ftyp.length + mdat.length + moov.length);
  out.set(ftyp, 0);
  out.set(mdat, ftyp.length);
  out.set(moov, ftyp.length + mdat.length);
  return out;
}
