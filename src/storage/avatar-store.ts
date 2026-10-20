import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AvatarRecordSchema, SAFE_AVATAR_ID, SAFE_VOICE_PROFILE_ID, VoiceProfileSchema, type Avatar, type AvatarRecord, type VoiceProfile } from "@/domain/avatar";
import { CorruptedDataError, readTextIfExists, writeFileAtomic } from "./atomic-file";
import { NotFoundError } from "./pipeline-store";

/**
 * Biblioteca de avatares e perfis de voz (Lote 6). Local, JSON atômico, validado com Zod.
 *   <dataDir>/avatars/<avatarId>.json   { current, revisions[] }  — revisões nunca são apagadas
 *   <dataDir>/voice-profiles.json       VoiceProfile[] (providerVoiceId só no servidor)
 * "Excluir" arquiva: jobs antigos continuam resolvendo a revisão que usaram.
 */
export interface AvatarLibraryStore {
  listAvatars(options?: { includeArchived?: boolean }): Promise<Avatar[]>;
  getAvatarRecord(id: string): Promise<AvatarRecord>;
  getAvatarRevision(id: string, revision: number): Promise<Avatar>;
  saveAvatarRecord(record: AvatarRecord): Promise<void>;
  listVoiceProfiles(): Promise<VoiceProfile[]>;
  saveVoiceProfiles(profiles: readonly VoiceProfile[]): Promise<void>;
}

function assertAvatarId(id: string): void {
  if (!SAFE_AVATAR_ID.test(id)) throw new Error(`ID de avatar inválido: ${JSON.stringify(id)}`);
}

const VoiceProfilesSchema = z.array(VoiceProfileSchema);

export class FileAvatarLibraryStore implements AvatarLibraryStore {
  private readonly avatarsDir: string;
  private readonly voicesPath: string;

  constructor(dataDir: string) {
    this.avatarsDir = join(dataDir, "avatars");
    this.voicesPath = join(dataDir, "voice-profiles.json");
  }

  async listAvatars(options: { includeArchived?: boolean } = {}): Promise<Avatar[]> {
    let names: string[];
    try {
      names = await readdir(this.avatarsDir);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => SAFE_AVATAR_ID.test(id));
    const records = await Promise.all(ids.map((id) => this.getAvatarRecord(id)));
    return records.map((r) => r.current).filter((a) => options.includeArchived || !a.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getAvatarRecord(id: string): Promise<AvatarRecord> {
    assertAvatarId(id);
    const raw = await readTextIfExists(join(this.avatarsDir, `${id}.json`));
    if (raw === undefined) throw new NotFoundError(`Avatar não encontrado: ${id}`);
    try {
      return AvatarRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new CorruptedDataError(`Avatar ilegível (${id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getAvatarRevision(id: string, revision: number): Promise<Avatar> {
    const record = await this.getAvatarRecord(id);
    const found = record.revisions.find((r) => r.revision === revision);
    if (!found) throw new NotFoundError(`Revisão ${revision} do avatar ${id} não encontrada.`);
    return found;
  }

  async saveAvatarRecord(record: AvatarRecord): Promise<void> {
    const parsed = AvatarRecordSchema.parse(record);
    assertAvatarId(parsed.current.id);
    await writeFileAtomic(join(this.avatarsDir, `${parsed.current.id}.json`), JSON.stringify(parsed, null, 2));
  }

  async listVoiceProfiles(): Promise<VoiceProfile[]> {
    const raw = await readTextIfExists(this.voicesPath);
    if (raw === undefined) return [];
    try {
      return VoiceProfilesSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new CorruptedDataError(`Perfis de voz ilegíveis: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async saveVoiceProfiles(profiles: readonly VoiceProfile[]): Promise<void> {
    const parsed = VoiceProfilesSchema.parse(profiles);
    for (const p of parsed) if (!SAFE_VOICE_PROFILE_ID.test(p.id)) throw new Error(`ID de voz inválido: ${p.id}`);
    await writeFileAtomic(this.voicesPath, JSON.stringify(parsed, null, 2));
  }
}

export class InMemoryAvatarLibraryStore implements AvatarLibraryStore {
  private readonly records = new Map<string, AvatarRecord>();
  private voices: VoiceProfile[] = [];

  async listAvatars(options: { includeArchived?: boolean } = {}): Promise<Avatar[]> {
    return [...this.records.values()].map((r) => r.current).filter((a) => options.includeArchived || !a.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getAvatarRecord(id: string): Promise<AvatarRecord> {
    const record = this.records.get(id);
    if (!record) throw new NotFoundError(`Avatar não encontrado: ${id}`);
    return structuredClone(record);
  }

  async getAvatarRevision(id: string, revision: number): Promise<Avatar> {
    const found = (await this.getAvatarRecord(id)).revisions.find((r) => r.revision === revision);
    if (!found) throw new NotFoundError(`Revisão ${revision} do avatar ${id} não encontrada.`);
    return found;
  }

  async saveAvatarRecord(record: AvatarRecord): Promise<void> {
    const parsed = AvatarRecordSchema.parse(record);
    this.records.set(parsed.current.id, structuredClone(parsed));
  }

  async listVoiceProfiles(): Promise<VoiceProfile[]> {
    return structuredClone(this.voices);
  }

  async saveVoiceProfiles(profiles: readonly VoiceProfile[]): Promise<void> {
    this.voices = VoiceProfilesSchema.parse(profiles);
  }
}
