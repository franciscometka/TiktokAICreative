import { resolveSceneVideoFile } from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";
import { serveFile } from "@/server/serve-file";
export const runtime = "nodejs";
export async function GET(request: Request, ctx: { params: Promise<{ campaignId: string; creativeId: string; sceneId: string; version: string }> }) {
  const file = await resolveSceneVideoFile(getRuntime().deps, await ctx.params);
  return file ? serveFile(request, file, "video/mp4") : new Response("Not found", { status: 404 });
}
