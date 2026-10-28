import { z } from "zod";
import { AvatarRecordSchema, AvatarSchema, SAFE_AVATAR_ID, SAFE_VOICE_PROFILE_ID, VoiceProfileSchema, type Avatar, type AvatarRecord, type VoiceProfile } from "@/domain/avatar";
import type { AvatarLibraryStore } from "@/storage/avatar-store";
import { NotFoundError } from "@/storage/pipeline-store";
import type { SqlClient } from "../db/sql";
import { timestamp } from "../db/time";

const json = (raw: unknown) => (typeof raw === "string" ? JSON.parse(raw) : raw);

/**
 * Biblioteca de avatares no Postgres (por usuário). Mesmas regras do FileAvatarLibraryStore:
 * revisões congeladas (inseridas uma vez, nunca alteradas nem apagadas), "excluir" arquiva.
 */
export class PostgresAvatarLibraryStore implements AvatarLibraryStore {
  constructor(private readonly db: SqlClient, readonly userId: string) {}

  async listAvatars(options: { includeArchived?: boolean } = {}): Promise<Avatar[]> {
    const r = await this.db.query<{ current: unknown }>(
      `select current from avatars where user_id = $1 ${options.includeArchived ? "" : "and archived = false"} order by updated_at desc`,
      [this.userId],
    );
    return r.rows.map((row) => AvatarSchema.parse(json(row.current)));
  }

  async getAvatarRecord(id: string): Promise<AvatarRecord> {
    if (!SAFE_AVATAR_ID.test(id)) throw new Error(`ID de avatar inválido: ${JSON.stringify(id)}`);
    const current = (await this.db.query<{ current: unknown }>("select current from avatars where id = $1 and user_id = $2", [id, this.userId])).rows[0];
    if (!current) throw new NotFoundError(`Avatar não encontrado: ${id}`);
    const revisions = await this.db.query<{ snapshot: unknown }>("select snapshot from avatar_revisions where avatar_id = $1 and user_id = $2 order by revision", [id, this.userId]);
    return AvatarRecordSchema.parse({ current: json(current.current), revisions: revisions.rows.map((row) => json(row.snapshot)) });
  }

  async getAvatarRevision(id: string, revision: number): Promise<Avatar> {
    const r = await this.db.query<{ snapshot: unknown }>("select snapshot from avatar_revisions where avatar_id = $1 and revision = $2 and user_id = $3", [id, revision, this.userId]);
    if (!r.rows[0]) throw new NotFoundError(`Revisão ${revision} do avatar ${id} não encontrada.`);
    return AvatarSchema.parse(json(r.rows[0].snapshot));
  }

  async saveAvatarRecord(record: AvatarRecord): Promise<void> {
    const parsed = AvatarRecordSchema.parse(record);
    const id = parsed.current.id;
    if (!SAFE_AVATAR_ID.test(id)) throw new Error(`ID de avatar inválido: ${JSON.stringify(id)}`);
    await this.db.transaction(async (tx) => {
      const r = await tx.query(
        `insert into avatars (id, user_id, current_revision, archived, current, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (id) do update set current_revision = excluded.current_revision, archived = excluded.archived, current = excluded.current, updated_at = excluded.updated_at
         where avatars.user_id = excluded.user_id`,
        [id, this.userId, parsed.current.revision, parsed.current.archived, JSON.stringify(parsed.current), timestamp(parsed.current.updatedAt)],
      );
      if (r.rowCount === 0) throw new NotFoundError(`Avatar não encontrado: ${id}`);
      for (const revision of parsed.revisions) {
        // Revisão existente nunca é reescrita (congelada no job que a usou).
        await tx.query(
          "insert into avatar_revisions (avatar_id, revision, user_id, snapshot) values ($1, $2, $3, $4::jsonb) on conflict (avatar_id, revision) do nothing",
          [id, revision.revision, this.userId, JSON.stringify(revision)],
        );
      }
    });
  }

  async listVoiceProfiles(): Promise<VoiceProfile[]> {
    const r = await this.db.query<{ profile: unknown }>("select profile from voice_profiles where user_id = $1 order by position, id", [this.userId]);
    return z.array(VoiceProfileSchema).parse(r.rows.map((row) => json(row.profile)));
  }

  async saveVoiceProfiles(profiles: readonly VoiceProfile[]): Promise<void> {
    const parsed = z.array(VoiceProfileSchema).parse(profiles);
    for (const p of parsed) if (!SAFE_VOICE_PROFILE_ID.test(p.id)) throw new Error(`ID de voz inválido: ${p.id}`);
    await this.db.transaction(async (tx) => {
      await tx.query("delete from voice_profiles where user_id = $1", [this.userId]);
      for (const [position, p] of parsed.entries()) {
        await tx.query("insert into voice_profiles (id, user_id, position, profile) values ($1, $2, $3, $4::jsonb)", [p.id, this.userId, position, JSON.stringify(p)]);
      }
    });
  }
}
