import { rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { allocateVersionDir } from "@/render/output-paths";
import { isMp4 } from "@/providers/video/mp4";

export interface VideoAssetStore {
  save(input: { campaignId: string; sceneId: string; data: Uint8Array; metadata: Record<string, unknown> }): Promise<{ uri: string }>;
}
/** Uma pasta vN por cena/tentativa; nunca sobrescreve a versão anterior. */
export class LocalVideoAssetStore implements VideoAssetStore {
  constructor(readonly rootDir: string) {}
  async save(input: Parameters<VideoAssetStore["save"]>[0]) {
    if (!isMp4(input.data)) throw new Error("Clipe não é MP4");
    const { dir, renderId } = await allocateVersionDir(this.rootDir, input.campaignId, input.sceneId);
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ version: renderId, ...input.metadata }, null, 2), { flag: "wx" });
    await writeFile(join(dir, "clip.partial.mp4"), input.data, { flag: "wx" });
    await rename(join(dir, "clip.partial.mp4"), join(dir, "clip.mp4"));
    return { uri: relative(process.cwd(), join(dir, "clip.mp4")).replaceAll("\\", "/") };
  }
}
