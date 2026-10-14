/**
 * Lê largura/altura do cabeçalho de JPEG, PNG e WebP (sem dependência de biblioteca de imagem).
 * Usado para decidir cover × contain ANTES do render, de forma determinística.
 */
export interface ImageSize {
  width: number;
  height: number;
}

function be16(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function be32(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
}
function le16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function le24(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}

function png(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24) return undefined;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function jpeg(b: Uint8Array): ImageSize | undefined {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return undefined;
    const marker = b[o + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const length = be16(b, o + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: be16(b, o + 5), width: be16(b, o + 7) };
    o += 2 + length;
  }
  return undefined;
}

function webp(b: Uint8Array): ImageSize | undefined {
  const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
  if (chunk === "VP8 " && b.length >= 30) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return undefined;
}

export function imageDimensions(bytes: Uint8Array, contentType: string): ImageSize | undefined {
  const size = contentType === "image/png" ? png(bytes) : contentType === "image/jpeg" ? jpeg(bytes) : contentType === "image/webp" ? webp(bytes) : undefined;
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}
