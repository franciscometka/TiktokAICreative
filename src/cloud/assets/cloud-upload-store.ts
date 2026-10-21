import { randomUUID } from "node:crypto";
import {
  contentTypeForStoredName,
  IMAGE_TYPES,
  isImageContentType,
  SAFE_PRODUCT_ID,
  STORED_IMAGE_NAME,
  UPLOAD_LIMITS,
  UploadValidationError,
  validateImageUpload,
  type ImageContentType,
} from "@/domain/upload";
import { InvalidUploadPathError, type StoredImage, type UploadStore } from "@/storage/upload-store";
import type { AssetRepository } from "../repos/asset-repository";
import type { AssetStore, SignedUpload } from "./asset-store";
import { uploadLocalUri, type DataDirs } from "./storage-layout";

/**
 * Uploads no modo cloud (D106). Fluxo preferido = upload DIRETO do browser ao Storage:
 *   authorize (API valida tipo/tamanho, cria registro pending e URL de upload assinada)
 *   → browser envia o arquivo ao Supabase Storage (nunca passa pela API nem pelo Vercel)
 *   → complete (API baixa, confere conteúdo real e limite; marca ready ou rejeita e apaga).
 * `save` (bytes já no servidor) continua existindo para o fluxo local/compatível.
 */
export class CloudUploadStore implements UploadStore {
  constructor(
    private readonly repo: AssetRepository,
    private readonly storage: AssetStore,
    private readonly dirs: DataDirs,
    readonly userId: string,
  ) {}

  private ownerKind(ownerId: string): "product" | "avatar" {
    return ownerId.startsWith("avatar_") ? "avatar" : "product";
  }

  private key(ownerId: string, id: string): string {
    if (!SAFE_PRODUCT_ID.test(ownerId)) throw new InvalidUploadPathError("ID de produto inválido");
    if (!STORED_IMAGE_NAME.test(id)) throw new InvalidUploadPathError("Nome de imagem inválido");
    return `users/${this.userId}/uploads/${ownerId}/${id}`;
  }

  private describe(row: { id: string; ownerId: string; contentType: string; sizeBytes: number }): StoredImage {
    return { id: row.id, productId: row.ownerId, uri: uploadLocalUri(this.dirs, row.ownerId, row.id), contentType: row.contentType as ImageContentType, size: row.sizeBytes };
  }

  /** Passo 1 do upload direto. O browser recebe só a URL assinada desse único objeto. */
  async authorize(ownerId: string, file: { declaredType: string; size: number }): Promise<{ imageId: string; upload: SignedUpload }> {
    if (!isImageContentType(file.declaredType)) throw new UploadValidationError("unsupported_type");
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > UPLOAD_LIMITS.maxBytes) throw new UploadValidationError("too_large");
    if ((await this.repo.listUploads(ownerId, { includePending: true })).length >= UPLOAD_LIMITS.maxImagesPerProduct) throw new UploadValidationError("limit_reached");
    const imageId = `img_${randomUUID()}.${IMAGE_TYPES[file.declaredType]}`;
    const path = this.key(ownerId, imageId);
    await this.repo.createPendingUpload({ id: imageId, ownerId, ownerKind: this.ownerKind(ownerId), bucket: this.storage.bucket, path, localUri: uploadLocalUri(this.dirs, ownerId, imageId), contentType: file.declaredType, sizeBytes: file.size });
    return { imageId, upload: await this.storage.createSignedUpload(path) };
  }

  /** Passo 3: confere o arquivo REAL (assinatura de bytes, tipo, tamanho) antes de aceitar. */
  async complete(ownerId: string, imageId: string): Promise<StoredImage> {
    const row = await this.repo.getUpload(ownerId, imageId);
    if (!row) throw new InvalidUploadPathError("Upload não encontrado");
    if (row.status === "ready") return this.describe(row);
    if (row.status === "rejected") throw new UploadValidationError("unsupported_type");
    const bytes = await this.storage.get(row.path);
    if (!bytes) throw new UploadValidationError("unsupported_type");
    try {
      const { contentType } = validateImageUpload({ bytes, size: bytes.byteLength, declaredType: row.contentType });
      if (contentType !== row.contentType) throw new UploadValidationError("unsupported_type");
    } catch (error) {
      await this.repo.setUploadStatus(ownerId, imageId, "rejected");
      await this.storage.delete(row.path).catch(() => false);
      throw error;
    }
    await this.repo.setUploadStatus(ownerId, imageId, "ready", bytes.byteLength);
    return this.describe({ ...row, sizeBytes: bytes.byteLength });
  }

  async save(productId: string, file: { bytes: Uint8Array; size: number; declaredType: string }): Promise<StoredImage> {
    const { contentType, extension } = validateImageUpload(file);
    if ((await this.repo.listUploads(productId, { includePending: true })).length >= UPLOAD_LIMITS.maxImagesPerProduct) throw new UploadValidationError("limit_reached");
    const id = `img_${randomUUID()}.${extension}`;
    const path = this.key(productId, id);
    await this.repo.createPendingUpload({ id, ownerId: productId, ownerKind: this.ownerKind(productId), bucket: this.storage.bucket, path, localUri: uploadLocalUri(this.dirs, productId, id), contentType, sizeBytes: file.bytes.byteLength });
    await this.storage.put(path, file.bytes, { contentType });
    await this.repo.setUploadStatus(productId, id, "ready", file.bytes.byteLength);
    return this.describe({ id, ownerId: productId, contentType, sizeBytes: file.bytes.byteLength });
  }

  async list(productId: string): Promise<StoredImage[]> {
    if (!SAFE_PRODUCT_ID.test(productId)) throw new InvalidUploadPathError("ID de produto inválido");
    return (await this.repo.listUploads(productId)).map((r) => this.describe(r));
  }

  async resolve(productId: string, imageIds: readonly string[]): Promise<StoredImage[]> {
    const available = new Map((await this.list(productId)).map((i) => [i.id, i]));
    return imageIds.flatMap((id) => (available.has(id) ? [available.get(id)!] : []));
  }

  async read(productId: string, imageId: string): Promise<{ bytes: Uint8Array; contentType: ImageContentType } | undefined> {
    const contentType = contentTypeForStoredName(imageId);
    const row = contentType ? await this.repo.getUpload(productId, imageId) : undefined;
    if (!row || row.status !== "ready" || !contentType) return undefined;
    const bytes = await this.storage.get(row.path);
    return bytes ? { bytes, contentType } : undefined;
  }

  /** URL assinada temporária da imagem (preview no browser). */
  async signedUrl(productId: string, imageId: string, ttlSeconds: number): Promise<string | undefined> {
    const row = await this.repo.getUpload(productId, imageId);
    if (!row || row.status !== "ready") return undefined;
    return this.storage.getSignedUrl(row.path, { expiresInSeconds: ttlSeconds });
  }

  async remove(productId: string, imageId: string): Promise<boolean> {
    const row = await this.repo.getUpload(productId, imageId);
    if (!row) return false;
    await this.storage.delete(row.path).catch(() => false);
    return this.repo.deleteUpload(productId, imageId);
  }
}
