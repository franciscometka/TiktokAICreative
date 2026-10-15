import { readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { allocateVersionDir } from "@/render/output-paths";
import { inspectMp4, isMp4, type Mp4Inspection } from "@/providers/video/mp4";

export interface SavedClip {
  uri: string;
  /** Leitura do arquivo DEPOIS de gravado (duração real e se está completo). */
  inspection: Mp4Inspection;
}

export interface VideoAssetStore {
  save(input: { campaignId: string; sceneId: string; data: Uint8Array; metadata: Record<string, unknown> }): Promise<SavedClip>;
  /** Grava a checagem de integridade no metadata da versão (auditoria). */
  writeIntegrity?(uri: string, integrity: Record<string, unknown>): Promise<void>;
}
/** Uma pasta vN por cena/tentativa; nunca sobrescreve a versão anterior. */
export class LocalVideoAssetStore implements VideoAssetStore {
  constructor(readonly rootDir: string) {}
  async save(input: Parameters<VideoAssetStore["save"]>[0]): Promise<SavedClip> {
    if (!isMp4(input.data)) throw new Error("Clipe não é MP4");
    const { dir, renderId } = await allocateVersionDir(this.rootDir, input.campaignId, input.sceneId);
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ version: renderId, ...input.metadata }, null, 2), { flag: "wx" });
    await writeFile(join(dir, "clip.partial.mp4"), input.data, { flag: "wx" });
    await rename(join(dir, "clip.partial.mp4"), join(dir, "clip.mp4"));
    // Mede o arquivo SALVO (não os bytes em memória): é ele que vai para o render.
    const inspection = inspectMp4(new Uint8Array(await readFile(join(dir, "clip.mp4"))));
    return { uri: relative(process.cwd(), join(dir, "clip.mp4")).replaceAll("\\", "/"), inspection };
  }
  async writeIntegrity(uri: string, integrity: Record<string, unknown>): Promise<void> {
    // Arquivo separado: metadata.json é escrito uma vez (wx) e nunca reescrito.
    await writeFile(join(uri, "..", "integrity.json"), JSON.stringify(integrity, null, 2), { flag: "wx" });
  }
}
