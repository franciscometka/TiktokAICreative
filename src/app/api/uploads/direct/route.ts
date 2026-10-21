import { NextResponse } from "next/server";
import { z } from "zod";
import { remoteAction } from "@/server/backend";
import { runtimeMode } from "@/server/session";

export const runtime = "nodejs";

/**
 * Lote 7 (modo cloud): upload DIRETO ao Supabase Storage.
 *   step=authorize → a Render API valida tipo/tamanho e devolve UMA URL de upload assinada;
 *   o browser envia o arquivo direto ao Storage (não passa por Vercel nem pela API);
 *   step=complete  → a API baixa e confere os bytes reais antes de aceitar.
 * Só JSON pequeno passa por aqui; o token da sessão fica no servidor (cookie httpOnly).
 */
const Input = z.discriminatedUnion("step", [
  z.object({ step: z.literal("authorize"), ownerId: z.string().max(64), contentType: z.string().max(40), size: z.number().int().positive() }),
  z.object({ step: z.literal("complete"), ownerId: z.string().max(64), imageId: z.string().max(80) }),
]);

export async function POST(request: Request) {
  if (runtimeMode() !== "cloud") return new Response("Not found", { status: 404 });
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const parsed = Input.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ ok: false, error: { code: "upload", title: "Imagem recusada", message: "Envio inválido.", retryable: false } }, { status: 400 });
  const { step, ...body } = parsed.data;
  const result = await remoteAction("POST", `/v1/uploads/${step}`, body);
  return NextResponse.json(result, { status: result.ok ? 201 : 422 });
}
