import { resolveUgcReferenceFile } from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";
import { serveFile } from "@/server/serve-file";

export const runtime = "nodejs";

/** Imagem de referência AI UGC (pessoa + produto) por IDs — nunca por caminho. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ campaignId: string; creativeId: string; version: string }> },
) {
  const file = await resolveUgcReferenceFile(getRuntime().deps, await ctx.params);
  if (!file) return new Response("Not found", { status: 404 });
  return serveFile(request, file, file.mimeType);
}
