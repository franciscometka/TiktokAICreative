import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRICING_TABLE } from "@/config/pricing";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { RunwayVideoProvider } from "@/providers/video/runway-video-provider";
const pricing = PRICING_TABLE.find((p) => p.provider === RUNWAY_VIDEO.provider)!;
export const MP4 = Buffer.from("000000186674797069736f6d00000200", "hex");
export async function runwayFixture(options: { failure?: boolean; downloadFailure?: boolean; statusInvalid?: boolean; pending?: boolean; outputUrl?: string; httpError?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "runway-"));
  await mkdir(join(root, "uploads"));
  const image = join(root, "uploads", "photo.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (options.httpError) throw new Error("secret-test-key");
    if (url.endsWith("/image_to_video")) return Response.json({ id: "task_1" });
    if (url.includes("/tasks/")) return Response.json(options.statusInvalid ? {} : { id: "task_1", status: options.pending ? "RUNNING" : options.failure ? "FAILED" : "SUCCEEDED", cost: { credits: options.failure ? 0 : 25 }, output: [options.outputUrl ?? "https://cdn.runwayml.com/clip.mp4"] });
    return options.downloadFailure ? new Response("bad", { status: 500 }) : new Response(MP4);
  };
  const provider = new RunwayVideoProvider({ pricing, apiKey: "secret-test-key", uploadsDir: join(root, "uploads"), transport });
  const request = { sceneId: "scene_1", prompt: "Slow push in", durationSeconds: 3, aspectRatio: "9:16" as const, referenceImageUris: [image] };
  // Assets persistidos usam URIs relativas ao cwd, mesmo quando a raiz é absoluta.
  const { relative } = await import("node:path");
  request.referenceImageUris = [relative(process.cwd(), image)];
  return { root, image, provider, request, calls, transport };
}
