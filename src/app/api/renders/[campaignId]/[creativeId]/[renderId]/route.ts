import { resolveRenderFile } from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";
import { serveFile } from "@/server/serve-file";
import { cloudAssetRedirect } from "@/server/asset-redirect";
import { runtimeMode } from "@/server/session";

export const runtime = "nodejs";

/**
 * Serve o MP4 de um render por IDs (nunca por caminho). `?download=1` força download.
 * Suporta Range (206) para o <video> conseguir buscar posição e mostrar a duração.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ campaignId: string; creativeId: string; renderId: string }> },
) {
  const ids = await ctx.params;
  if (runtimeMode() === "cloud") return cloudAssetRedirect({ kind: "render", ...ids, ...(new URL(request.url).searchParams.get("download") === "1" ? { download: "1" } : {}) });
  const file = await resolveRenderFile(getRuntime().deps, ids);
  if (!file) return new Response("Not found", { status: 404 });
  return serveFile(request, file, "video/mp4");
}
