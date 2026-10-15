/** Assinatura ISO BMFF; a decodificação completa é responsabilidade do renderer. */
export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && Buffer.from(bytes).toString("ascii", 4, 8) === "ftyp";
}

/** Resultado da leitura da estrutura do MP4 (sem decodificar quadros). */
export interface Mp4Inspection {
  /** Todas as caixas de topo cabem no arquivo (download/escrita não foi cortado no meio). */
  complete: boolean;
  /** Duração da trilha de VÍDEO (mdhd); sem trilha de vídeo, a do filme (mvhd). undefined = ilegível. */
  durationSeconds: number | undefined;
  hasVideoTrack: boolean;
}

function u32(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
}
const type = (b: Uint8Array, o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

interface Box {
  type: string;
  start: number;
  end: number;
  /** A caixa declara terminar depois do fim do arquivo. */
  truncated: boolean;
}

/** Caixas irmãs em [start, end). */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header) {
      out.push({ type: type(b, o + 4), start: o + header, end, truncated: true });
      break;
    }
    out.push({ type: type(b, o + 4), start: o + header, end: Math.min(o + size, end), truncated: o + size > end });
    o += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, name: string) => boxes(b, parent.start, parent.end).find((x) => x.type === name);

/** mvhd/mdhd: versão 0 (32 bits) ou 1 (64 bits) → segundos. */
function headerDuration(b: Uint8Array, box: Box): number | undefined {
  const version = b[box.start] ?? 0;
  const o = box.start + 4;
  const timescale = version === 1 ? u32(b, o + 16) : u32(b, o + 8);
  const duration = version === 1 ? u32(b, o + 20) * 2 ** 32 + u32(b, o + 24) : u32(b, o + 12);
  if (!timescale || box.end - box.start < (version === 1 ? 32 : 20)) return undefined;
  return Math.round((duration / timescale) * 1000) / 1000;
}

/**
 * Lê a duração REAL declarada no arquivo (trilha de vídeo) e se ele está completo. Não confia no
 * que foi pedido nem no que o provider informa: é a fonte da verdade do clipe salvo.
 */
export function inspectMp4(bytes: Uint8Array): Mp4Inspection {
  if (!isMp4(bytes)) return { complete: false, durationSeconds: undefined, hasVideoTrack: false };
  const top = boxes(bytes, 0, bytes.length);
  const complete = top.length > 0 && top.every((x) => !x.truncated);
  const moov = top.find((x) => x.type === "moov" && !x.truncated);
  if (!moov) return { complete, durationSeconds: undefined, hasVideoTrack: false };
  for (const trak of boxes(bytes, moov.start, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(bytes, trak, "mdia");
    const hdlr = mdia && child(bytes, mdia, "hdlr");
    const mdhd = mdia && child(bytes, mdia, "mdhd");
    // hdlr: versão/flags (4) + pre_defined (4) + handler_type (4).
    if (hdlr && mdhd && type(bytes, hdlr.start + 8) === "vide") {
      return { complete, durationSeconds: headerDuration(bytes, mdhd), hasVideoTrack: true };
    }
  }
  const mvhd = child(bytes, moov, "mvhd");
  return { complete, durationSeconds: mvhd ? headerDuration(bytes, mvhd) : undefined, hasVideoTrack: false };
}
