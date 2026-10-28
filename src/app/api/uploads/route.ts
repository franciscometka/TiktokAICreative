import { NextResponse } from "next/server";
import { uploadProductImage } from "@/application/campaign-actions";
import { UPLOAD_LIMITS } from "@/domain/upload";
import { getRuntime } from "@/server/runtime";
import { deployMisconfiguration } from "@/lib/runtime-mode";
import { runtimeMode } from "@/server/session";

export const runtime = "nodejs";

/**
 * POST multipart: `file` (imagem) + `productId` opcional. Route handler fino; a validação de
 * tipo/tamanho/conteúdo e a gravação ficam em application/ e storage/.
 * Nunca recebe caminhos: o servidor gera o nome e decide a pasta.
 */
export async function POST(request: Request) {
  // Lote 7: no cloud o upload é direto ao Storage (/api/uploads/direct); arquivo não passa por aqui.
  if (runtimeMode() === "cloud") return new Response("Not found", { status: 404 });
  // Build de Vercel sem modo cloud (ex.: variáveis só em Production e deploy Preview): o arquivo
  // NUNCA é gravado no disco da Vercel; a tela mostra a causa em vez de "erro inesperado".
  const misconfigured = deployMisconfiguration();
  if (misconfigured) {
    console.error("[upload] deploy sem modo cloud:", misconfigured);
    return NextResponse.json({ ok: false, error: { code: "unavailable", title: "Deploy sem modo cloud", message: misconfigured, retryable: false } }, { status: 503 });
  }
  // Mesmo critério dos Server Actions: só aceita envio da própria origem (anti-CSRF).
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && safeHost(origin) !== host) {
    return new Response("Forbidden", { status: 403 });
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  // Margem para os campos do multipart; o limite real é checado nos bytes do arquivo.
  if (length > UPLOAD_LIMITS.maxBytes + 64 * 1024) {
    return NextResponse.json(
      { ok: false, error: { code: "upload", title: "Imagem recusada", message: "A imagem passa do tamanho máximo.", retryable: false } },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "upload", title: "Imagem recusada", message: "Envio inválido.", retryable: false } },
      { status: 400 },
    );
  }
  const file = form.get("file");
  const productId = form.get("productId");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: { code: "upload", title: "Imagem recusada", message: "Nenhum arquivo enviado.", retryable: false } },
      { status: 400 },
    );
  }

  const result = await uploadProductImage(getRuntime().deps, {
    productId: typeof productId === "string" && productId !== "" ? productId : null,
    file: { bytes: new Uint8Array(await file.arrayBuffer()), size: file.size, type: file.type },
  });
  return NextResponse.json(result, { status: result.ok ? 201 : 422 });
}

function safeHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
