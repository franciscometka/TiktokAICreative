import { resolveNarrationFile } from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";
import { serveFile } from "@/server/serve-file";
import { cloudAssetRedirect } from "@/server/asset-redirect";
import { runtimeMode } from "@/server/session";

export const runtime = "nodejs";

/** Serve a narração (MP3) de uma versão por IDs — nunca por caminho. `?download=1` força download. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ campaignId: string; creativeId: string; version: string }> },
) {
  const ids = await ctx.params;
  if (runtimeMode() === "cloud") return cloudAssetRedirect({ kind: "audio", ...ids });
  const file = await resolveNarrationFile(getRuntime().deps, ids);
  if (!file) return new Response("Not found", { status: 404 });
  return serveFile(request, file, "audio/mpeg");
}
