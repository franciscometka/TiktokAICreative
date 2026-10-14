/**
 * Regras PURAS de upload de imagens do produto. O tipo é detectado pelos bytes (assinatura do
 * arquivo); o MIME declarado pelo navegador e o nome original nunca são confiáveis sozinhos.
 */

export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type ImageContentType = keyof typeof IMAGE_TYPES;
export type ImageExtension = (typeof IMAGE_TYPES)[ImageContentType];

export const UPLOAD_LIMITS = {
  /** 8 MB por imagem: suficiente para fotos de celular, pequeno para o disco local. */
  maxBytes: 8 * 1024 * 1024,
  maxImagesPerProduct: 6,
} as const;

/** ID de produto aceito em caminhos de arquivo (sem `/`, `\`, `.`, espaços). */
export const SAFE_PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Nome de arquivo GERADO pelo sistema; qualquer outro nome é recusado. */
export const STORED_IMAGE_NAME = /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export type UploadErrorCode = "empty" | "too_large" | "unsupported_type" | "type_mismatch" | "limit_reached";

export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  empty: "O arquivo está vazio.",
  too_large: `A imagem passa de ${UPLOAD_LIMITS.maxBytes / (1024 * 1024)} MB.`,
  unsupported_type: "Formato não suportado. Envie JPG, PNG ou WebP.",
  type_mismatch: "O conteúdo do arquivo não corresponde a uma imagem JPG, PNG ou WebP.",
  limit_reached: `Limite de ${UPLOAD_LIMITS.maxImagesPerProduct} imagens por produto.`,
};

export class UploadValidationError extends Error {
  override name = "UploadValidationError";
  constructor(readonly code: UploadErrorCode) {
    super(UPLOAD_ERROR_MESSAGES[code]);
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Detecta JPEG/PNG/WebP pela assinatura. */
export function detectImageType(bytes: Uint8Array): ImageContentType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
}

export function isImageContentType(value: string): value is ImageContentType {
  return Object.hasOwn(IMAGE_TYPES, value);
}

/**
 * Valida tamanho, MIME declarado e conteúdo real. Retorna o tipo DETECTADO (fonte da extensão).
 * Lança UploadValidationError.
 */
export function validateImageUpload(input: { size: number; declaredType: string; bytes: Uint8Array }): {
  contentType: ImageContentType;
  extension: ImageExtension;
} {
  if (input.size <= 0 || input.bytes.length === 0) throw new UploadValidationError("empty");
  if (input.size > UPLOAD_LIMITS.maxBytes || input.bytes.length > UPLOAD_LIMITS.maxBytes) {
    throw new UploadValidationError("too_large");
  }
  if (!isImageContentType(input.declaredType)) throw new UploadValidationError("unsupported_type");
  const detected = detectImageType(input.bytes);
  if (!detected) throw new UploadValidationError("type_mismatch");
  if (detected !== input.declaredType) throw new UploadValidationError("type_mismatch");
  return { contentType: detected, extension: IMAGE_TYPES[detected] };
}

export function contentTypeForStoredName(name: string): ImageContentType | undefined {
  const match = STORED_IMAGE_NAME.exec(name);
  if (!match) return undefined;
  const ext = match[1];
  return (Object.keys(IMAGE_TYPES) as ImageContentType[]).find((t) => IMAGE_TYPES[t] === ext);
}
