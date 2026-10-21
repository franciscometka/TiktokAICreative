import { resolveSceneVideoFile } from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";
import { serveFile } from "@/server/serve-file";
import { cloudAssetRedirect } from "@/server/asset-redirect";
import { runtimeMode } from "@/server/session";
export const runtime = "nodejs";
export async function GET(request: Request, ctx: { params: Promise<{ campaignId: string; creativeId: string; sceneId: string; version: string }> }) {
  const ids = await ctx.params;
  if (runtimeMode() === "cloud") return cloudAssetRedirect({ kind: "clip", ...ids });
  const file = await resolveSceneVideoFile(getRuntime().deps, ids);
  return file ? serveFile(request, file, "video/mp4") : new Response("Not found", { status: 404 });
}
