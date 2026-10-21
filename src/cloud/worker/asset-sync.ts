import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import type { AssetStore } from "../assets/asset-store";
import { contentTypeForPath, projectDirs, storageKeyForLocalUri, type DataDirs } from "../assets/storage-layout";
import type { AssetRepository } from "../repos/asset-repository";

/**
 * Ponte Storage ⇄ disco temporário do worker (D106).
 * - hydrate: antes da tarefa, baixa para o workspace tudo que o job precisa (fotos do produto,
 *   foto do avatar, referências/clipes/áudio/renders já gerados), nas MESMAS URIs relativas que
 *   o documento do job usa. O pipeline roda sem saber que existe nuvem.
 * - publish: depois (sucesso OU falha), sobe os arquivos NOVOS das pastas do projeto e registra
 *   em generated_assets. Arquivos são imutáveis (pastas vN, nunca sobrescritas): upload sem upsert.
 */

const norm = (p: string) => p.replaceAll("\\", "/");

async function walk(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && !e.name.endsWith(".partial.mp4") && !e.name.includes(".tmp")) out.push(full);
  }
  return out;
}

function localTarget(workspace: string, uri: string): string {
  const base = resolve(workspace);
  const full = resolve(base, uri);
  if (!full.startsWith(base + sep)) throw new Error("URI fora do workspace");
  return full;
}

export class AssetSync {
  constructor(
    private readonly storage: AssetStore,
    private readonly repo: AssetRepository,
    private readonly dirs: DataDirs,
    private readonly userId: string,
  ) {}

  /** Baixa os arquivos do projeto e as fotos (produto + avatares usados). */
  async hydrate(workspace: string, campaign: Campaign, jobs: readonly GenerationJob[]): Promise<number> {
    let count = 0;
    const owners = new Set<string>([campaign.request.product.id]);
    for (const image of campaign.request.product.images) {
      const owner = norm(image.uri).split("/").slice(-2, -1)[0];
      if (owner) owners.add(owner);
    }
    const avatarRef = campaign.request.avatar?.snapshot?.referenceImage;
    if (avatarRef) owners.add(avatarRef.ownerId);
    for (const job of jobs) if (job.avatar?.avatarReferenceAsset) owners.add(job.avatar.avatarReferenceAsset.ownerId);
    for (const owner of owners) {
      for (const row of await this.repo.listUploads(owner)) {
        await this.storage.downloadToTemp(row.path, localTarget(workspace, row.localUri));
        count++;
      }
    }
    for (const row of await this.repo.listGenerated(campaign.id)) {
      await this.storage.downloadToTemp(row.path, localTarget(workspace, row.localUri));
      count++;
    }
    return count;
  }

  /** Sobe arquivos novos das pastas do projeto. Devolve as URIs publicadas nesta chamada. */
  async publish(workspace: string, campaignId: string): Promise<string[]> {
    const known = new Set((await this.repo.listGenerated(campaignId)).map((r) => r.localUri));
    const published: string[] = [];
    for (const dir of projectDirs(this.dirs, campaignId)) {
      for (const file of await walk(resolve(workspace, dir))) {
        const uri = norm(relative(resolve(workspace), file));
        if (known.has(uri)) continue;
        const { key, kind } = storageKeyForLocalUri(this.userId, uri, this.dirs);
        if (kind === "upload") continue;
        const data = new Uint8Array(await readFile(file));
        const contentType = contentTypeForPath(file);
        if (!(await this.storage.exists(key))) await this.storage.put(key, data, { contentType });
        await this.repo.recordGenerated({ campaignId, kind, bucket: this.storage.bucket, path: key, localUri: uri, contentType, sizeBytes: (await stat(file)).size, sha256: createHash("sha256").update(data).digest("hex") });
        published.push(uri);
      }
    }
    return published;
  }
}
