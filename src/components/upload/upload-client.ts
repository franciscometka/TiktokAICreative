import type { ActionResult, UploadedImageView } from "@/application/campaign-actions";
import { IMAGE_TYPES, UPLOAD_ERROR_MESSAGES, UPLOAD_LIMITS, isImageContentType } from "@/domain/upload";
import { BUILD_RUNTIME_MODE } from "@/lib/runtime-mode";

/**
 * L8.3 — envio de imagem do produto, compartilhado pela Home, pelo Create e pelo uploader legado.
 * Cloud: browser → URL assinada → Supabase Storage (o arquivo NUNCA passa por Vercel/Render;
 * só JSON pequeno vai a /api/uploads/direct). Local: multipart para /api/uploads.
 * A checagem aqui é só conveniência; o servidor valida MIME, tamanho e o conteúdo real de novo.
 */

export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(",");
export const MAX_IMAGE_MB = UPLOAD_LIMITS.maxBytes / (1024 * 1024);

/** Lote 7: no modo cloud o arquivo vai DIRETO ao Storage (URL assinada). */
const DIRECT_UPLOAD = BUILD_RUNTIME_MODE === "cloud";

async function directUpload(productId: string, file: File): Promise<ActionResult<UploadedImageView>> {
  const step = async <T,>(body: Record<string, unknown>) => (await (await fetch("/api/uploads/direct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as ActionResult<T>;
  const authorized = await step<{ imageId: string; uploadUrl: string }>({ step: "authorize", ownerId: productId, contentType: file.type, size: file.size });
  if (!authorized.ok) return authorized;
  const put = await fetch(authorized.value.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file });
  if (!put.ok) return { ok: false, error: { code: "upload", title: "Imagem recusada", message: "Falha no envio.", retryable: true } };
  return step<UploadedImageView>({ step: "complete", ownerId: productId, imageId: authorized.value.imageId });
}

/** Envia UMA imagem. Erro de rede vira resultado (nunca exceção para a tela). */
export async function uploadProductImage(productId: string, file: File): Promise<ActionResult<UploadedImageView>> {
  try {
    if (DIRECT_UPLOAD) return await directUpload(productId, file);
    const body = new FormData();
    body.set("file", file);
    body.set("productId", productId);
    return (await (await fetch("/api/uploads", { method: "POST", body })).json()) as ActionResult<UploadedImageView>;
  } catch {
    return { ok: false, error: { code: "upload", title: "Imagem recusada", message: "falha no envio.", retryable: true } };
  }
}

/** Separa os arquivos aceitáveis (tipo, tamanho, vagas) das mensagens de problema. Pura. */
export function screenFiles(files: readonly { name: string; type: string; size: number }[], remaining: number): { accepted: number[]; problems: string[] } {
  const problems: string[] = [];
  const accepted: number[] = [];
  files.forEach((file, i) => {
    if (!isImageContentType(file.type)) problems.push(`${file.name}: ${UPLOAD_ERROR_MESSAGES.unsupported_type}`);
    else if (file.size > UPLOAD_LIMITS.maxBytes) problems.push(`${file.name}: ${UPLOAD_ERROR_MESSAGES.too_large}`);
    else accepted.push(i);
  });
  if (accepted.length > Math.max(0, remaining)) {
    problems.push(UPLOAD_ERROR_MESSAGES.limit_reached);
    accepted.splice(Math.max(0, remaining));
  }
  return { accepted, problems };
}
