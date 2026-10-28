import { rm, stat, writeFile } from "node:fs/promises";
import { renameWithRetry } from "./atomic-file";
import { join } from "node:path";
import { allocateVersionDir, relativeRenderUri, RENDER_ID, SAFE_ENTITY_ID, versionDir } from "@/render/output-paths";

/**
 * Referências AI UGC (pessoa + produto) versionadas, fora do git:
 *   <UGC_DIR>/<campaignId>/<creativeId>/v<N>/{reference.png|jpg, metadata.json}
 * Reserva atômica de versão (mesma regra dos renders/narrações): nada é sobrescrito nem apagado.
 * O browser só recebe IDs (rota /api/ugc/...). Mock não grava arquivo (URI mock://).
 */

export const REFERENCE_FILES = { "image/png": "reference.png", "image/jpeg": "reference.jpg", "image/webp": "reference.webp" } as const;
export type ReferenceMime = keyof typeof REFERENCE_FILES;

export interface UgcAssetStore {
  readonly rootDir: string;
  saveReference(input: { campaignId: string; creativeId: string; data: Uint8Array; mimeType: ReferenceMime; metadata: Record<string, unknown> }): Promise<{ version: string; uri: string; sizeBytes: number }>;
  resolveReference(ids: { campaignId: string; creativeId: string; version: string }): Promise<{ absolutePath: string; sizeBytes: number; mimeType: ReferenceMime } | undefined>;
  /** Próxima versão livre sem gravar (usada para o rótulo do mock). */
  nextVersion(ids: { campaignId: string; creativeId: string }, existing: number): string;
}

export class LocalUgcAssetStore implements UgcAssetStore {
  constructor(readonly rootDir: string) {}

  async saveReference(input: { campaignId: string; creativeId: string; data: Uint8Array; mimeType: ReferenceMime; metadata: Record<string, unknown> }) {
    const file = REFERENCE_FILES[input.mimeType];
    if (!file) throw new Error("Tipo de imagem de referência não suportado");
    const { renderId: version, dir } = await allocateVersionDir(this.rootDir, input.campaignId, input.creativeId);
    try {
      // Nomes literais por tipo: caminho dinâmico faria o bundler rastrear o projeto inteiro.
      const [tmp, target] = input.mimeType === "image/png" ? [join(dir, "reference.png.partial"), join(dir, "reference.png")]
        : input.mimeType === "image/jpeg" ? [join(dir, "reference.jpg.partial"), join(dir, "reference.jpg")]
        : [join(dir, "reference.webp.partial"), join(dir, "reference.webp")];
      await writeFile(tmp, input.data, { flag: "wx" });
      await renameWithRetry(tmp, target);
      await writeFile(join(dir, "metadata.json"), JSON.stringify({ version, ...input.metadata }, null, 2), { flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { version, uri: relativeRenderUri(this.rootDir, input.campaignId, input.creativeId, version, file), sizeBytes: input.data.length };
  }

  async resolveReference(ids: { campaignId: string; creativeId: string; version: string }) {
    if (!SAFE_ENTITY_ID.test(ids.campaignId) || !SAFE_ENTITY_ID.test(ids.creativeId) || !RENDER_ID.test(ids.version)) return undefined;
    const dir = versionDir(this.rootDir, ids.campaignId, ids.creativeId, ids.version);
    for (const [mimeType, file] of Object.entries(REFERENCE_FILES) as [ReferenceMime, string][]) {
      try {
        const info = await stat(join(dir, file));
        if (info.isFile()) return { absolutePath: join(dir, file), sizeBytes: info.size, mimeType };
      } catch {
        // próxima extensão
      }
    }
    return undefined;
  }

  nextVersion(_ids: { campaignId: string; creativeId: string }, existing: number): string {
    return `v${existing + 1}`;
  }
}

/** Em memória (testes). */
export class InMemoryUgcAssetStore implements UgcAssetStore {
  readonly saved: { campaignId: string; creativeId: string; version: string; size: number }[] = [];
  constructor(readonly rootDir = "outputs/ugc") {}
  async saveReference(input: { campaignId: string; creativeId: string; data: Uint8Array; mimeType: ReferenceMime }) {
    const version = `v${this.saved.filter((s) => s.campaignId === input.campaignId && s.creativeId === input.creativeId).length + 1}`;
    this.saved.push({ campaignId: input.campaignId, creativeId: input.creativeId, version, size: input.data.length });
    return { version, uri: `${this.rootDir}/${input.campaignId}/${input.creativeId}/${version}/${REFERENCE_FILES[input.mimeType]}`, sizeBytes: input.data.length };
  }
  async resolveReference() {
    return undefined;
  }
  nextVersion(_ids: { campaignId: string; creativeId: string }, existing: number): string {
    return `v${existing + 1}`;
  }
}
