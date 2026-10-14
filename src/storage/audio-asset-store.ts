import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { NarrationTimingSchema, type NarrationTiming } from "@/domain/audio";
import { allocateVersionDir, relativeRenderUri, versionDir, InvalidRenderPathError, RENDER_ID, SAFE_ENTITY_ID } from "@/render/output-paths";

/**
 * Narrações como ASSETS versionados, independentes do renderer:
 *   <AUDIO_DIR>/<campaignId>/<creativeId>/v<N>/narration.mp3   (áudio)
 *                                             /timing.json     (palavras + janelas por cena)
 *                                             /metadata.json   (provider, modelo, voz, request id, custo)
 * Cada geração cria uma versão NOVA (mkdir atômico) — nada é sobrescrito nem apagado.
 * URIs são relativas (posix); o browser só recebe IDs (rota /api/audio/...).
 */

export const NARRATION_FILE = "narration.mp3";
export const TIMING_FILE = "timing.json";
export const METADATA_FILE = "metadata.json";

export interface SaveNarrationInput {
  campaignId: string;
  creativeId: string;
  data: Uint8Array;
  timing?: NarrationTiming;
  /** Dados de auditoria (sem segredo, sem caminho absoluto). */
  metadata: Record<string, unknown>;
}

export interface StoredNarration {
  version: string;
  uri: string;
  timingUri?: string;
  metadataUri: string;
  sizeBytes: number;
}

export interface AudioAssetStore {
  readonly rootDir: string;
  save(input: SaveNarrationInput): Promise<StoredNarration>;
  readTiming(timingUri: string): Promise<NarrationTiming | undefined>;
  /** Caminho absoluto de uma versão para servir ao browser (só por IDs validados). */
  resolveNarrationFile(ids: { campaignId: string; creativeId: string; version: string }): Promise<{ absolutePath: string; sizeBytes: number } | undefined>;
}

export class LocalAudioAssetStore implements AudioAssetStore {
  constructor(readonly rootDir: string) {}

  async save(input: SaveNarrationInput): Promise<StoredNarration> {
    const { renderId: version, dir } = await allocateVersionDir(this.rootDir, input.campaignId, input.creativeId);
    const uri = (file: string) => relativeRenderUri(this.rootDir, input.campaignId, input.creativeId, version, file);
    try {
      // Escreve com nome temporário e renomeia: um arquivo incompleto nunca tem o nome final.
      const audioTmp = join(dir, `${NARRATION_FILE}.partial`);
      await writeFile(audioTmp, input.data, { flag: "wx" });
      await rename(audioTmp, join(dir, NARRATION_FILE));
      if (input.timing) {
        await writeFile(join(dir, TIMING_FILE), JSON.stringify(NarrationTimingSchema.parse(input.timing), null, 2), { flag: "wx" });
      }
      await writeFile(join(dir, METADATA_FILE), JSON.stringify({ version, ...input.metadata }, null, 2), { flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      version,
      uri: uri(NARRATION_FILE),
      timingUri: input.timing ? uri(TIMING_FILE) : undefined,
      metadataUri: uri(METADATA_FILE),
      sizeBytes: input.data.length,
    };
  }

  async readTiming(timingUri: string): Promise<NarrationTiming | undefined> {
    const path = this.insideRoot(timingUri);
    if (!path.endsWith(`${sep}${TIMING_FILE}`)) throw new InvalidRenderPathError("Arquivo de timing inválido");
    try {
      return NarrationTimingSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async resolveNarrationFile(ids: { campaignId: string; creativeId: string; version: string }) {
    if (!SAFE_ENTITY_ID.test(ids.campaignId) || !SAFE_ENTITY_ID.test(ids.creativeId) || !RENDER_ID.test(ids.version)) return undefined;
    const absolutePath = join(versionDir(this.rootDir, ids.campaignId, ids.creativeId, ids.version), NARRATION_FILE);
    try {
      const info = await stat(absolutePath);
      return info.isFile() ? { absolutePath, sizeBytes: info.size } : undefined;
    } catch {
      return undefined;
    }
  }

  /** URI relativa → caminho absoluto, sempre DENTRO da raiz (anti traversal). */
  private insideRoot(relativeUri: string): string {
    if (relativeUri.includes("\0")) throw new InvalidRenderPathError("URI inválida");
    const root = resolve(this.rootDir);
    const full = resolve(relativeUri);
    if (!full.startsWith(root + sep)) throw new InvalidRenderPathError("Arquivo fora da pasta de áudio");
    return full;
  }
}

/** Versão em memória (testes): mesmas versões vN e URIs, sem disco. */
export class InMemoryAudioAssetStore implements AudioAssetStore {
  readonly saved: (SaveNarrationInput & StoredNarration)[] = [];
  private readonly timings = new Map<string, NarrationTiming>();

  constructor(readonly rootDir = "outputs/audio") {}

  async save(input: SaveNarrationInput): Promise<StoredNarration> {
    const n = this.saved.filter((x) => x.campaignId === input.campaignId && x.creativeId === input.creativeId).length + 1;
    const version = `v${n}`;
    const base = `${this.rootDir}/${input.campaignId}/${input.creativeId}/${version}`;
    const stored: StoredNarration = {
      version,
      uri: `${base}/${NARRATION_FILE}`,
      timingUri: input.timing ? `${base}/${TIMING_FILE}` : undefined,
      metadataUri: `${base}/${METADATA_FILE}`,
      sizeBytes: input.data.length,
    };
    if (input.timing && stored.timingUri) this.timings.set(stored.timingUri, NarrationTimingSchema.parse(input.timing));
    this.saved.push({ ...input, ...stored });
    return stored;
  }

  async readTiming(timingUri: string): Promise<NarrationTiming | undefined> {
    return this.timings.get(timingUri);
  }

  async resolveNarrationFile(): Promise<undefined> {
    return undefined;
  }
}
