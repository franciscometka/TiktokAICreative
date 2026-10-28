import type { SqlClient } from "../db/sql";
import type { AssetKind } from "../assets/storage-layout";

/**
 * Índice dos arquivos no Storage (D106). O banco guarda bucket + path (+ a URI local relativa
 * que o documento do job usa); URL assinada é gerada sob demanda e NUNCA persistida.
 */

export interface ProductAssetRow {
  id: string;
  ownerId: string;
  ownerKind: "product" | "avatar";
  bucket: string;
  path: string;
  localUri: string;
  contentType: string;
  sizeBytes: number;
  status: "pending" | "ready" | "rejected";
}

export interface GeneratedAssetRow {
  campaignId: string;
  kind: Exclude<AssetKind, "upload">;
  bucket: string;
  path: string;
  localUri: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

type ProductDbRow = { id: string; owner_id: string; owner_kind: "product" | "avatar"; bucket: string; path: string; local_uri: string; content_type: string; size_bytes: string | number; status: ProductAssetRow["status"] };
const product = (r: ProductDbRow): ProductAssetRow => ({ id: r.id, ownerId: r.owner_id, ownerKind: r.owner_kind, bucket: r.bucket, path: r.path, localUri: r.local_uri, contentType: r.content_type, sizeBytes: Number(r.size_bytes), status: r.status });

export class AssetRepository {
  constructor(private readonly db: SqlClient, readonly userId: string) {}

  async createPendingUpload(row: Omit<ProductAssetRow, "status">): Promise<void> {
    await this.db.query(
      `insert into product_assets (id, user_id, owner_id, owner_kind, bucket, path, local_uri, content_type, size_bytes, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [row.id, this.userId, row.ownerId, row.ownerKind, row.bucket, row.path, row.localUri, row.contentType, row.sizeBytes],
    );
  }

  async setUploadStatus(ownerId: string, id: string, status: "ready" | "rejected", sizeBytes?: number): Promise<boolean> {
    const r = await this.db.query(
      "update product_assets set status = $4, size_bytes = coalesce($5, size_bytes), updated_at = now() where owner_id = $1 and id = $2 and user_id = $3",
      [ownerId, id, this.userId, status, sizeBytes ?? null],
    );
    return r.rowCount > 0;
  }

  async getUpload(ownerId: string, id: string): Promise<ProductAssetRow | undefined> {
    const r = await this.db.query<ProductDbRow>("select * from product_assets where owner_id = $1 and id = $2 and user_id = $3", [ownerId, id, this.userId]);
    return r.rows[0] ? product(r.rows[0]) : undefined;
  }

  /** Uploads PRONTOS (validados) de um dono, em ordem de criação. */
  async listUploads(ownerId: string, options: { includePending?: boolean } = {}): Promise<ProductAssetRow[]> {
    const r = await this.db.query<ProductDbRow>(
      `select * from product_assets where owner_id = $1 and user_id = $2 and status ${options.includePending ? "in ('ready','pending')" : "= 'ready'"} order by created_at, id`,
      [ownerId, this.userId],
    );
    return r.rows.map(product);
  }

  async deleteUpload(ownerId: string, id: string): Promise<boolean> {
    const r = await this.db.query("delete from product_assets where owner_id = $1 and id = $2 and user_id = $3", [ownerId, id, this.userId]);
    return r.rowCount > 0;
  }

  async recordGenerated(row: GeneratedAssetRow): Promise<boolean> {
    const r = await this.db.query(
      `insert into generated_assets (user_id, campaign_id, kind, bucket, path, local_uri, content_type, size_bytes, sha256)
       select $1, c.id, $3, $4, $5, $6, $7, $8, $9 from campaigns c where c.id = $2 and c.user_id = $1
       on conflict (campaign_id, local_uri) do nothing`,
      [this.userId, row.campaignId, row.kind, row.bucket, row.path, row.localUri, row.contentType, row.sizeBytes, row.sha256],
    );
    return r.rowCount > 0;
  }

  async listGenerated(campaignId: string): Promise<GeneratedAssetRow[]> {
    const r = await this.db.query<{ campaign_id: string; kind: GeneratedAssetRow["kind"]; bucket: string; path: string; local_uri: string; content_type: string; size_bytes: string | number; sha256: string }>(
      "select * from generated_assets where campaign_id = $1 and user_id = $2 order by created_at, path",
      [campaignId, this.userId],
    );
    return r.rows.map((x) => ({ campaignId: x.campaign_id, kind: x.kind, bucket: x.bucket, path: x.path, localUri: x.local_uri, contentType: x.content_type, sizeBytes: Number(x.size_bytes), sha256: x.sha256 }));
  }

  /** Arquivo REGISTRADO deste usuário para a URI local (ownership antes de assinar URL). */
  async findGenerated(campaignId: string, localUri: string): Promise<GeneratedAssetRow | undefined> {
    return (await this.listGenerated(campaignId)).find((a) => a.localUri === localUri.replaceAll("\\", "/"));
  }
}
