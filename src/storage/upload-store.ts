import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  contentTypeForStoredName,
  SAFE_PRODUCT_ID,
  STORED_IMAGE_NAME,
  UPLOAD_LIMITS,
  UploadValidationError,
  validateImageUpload,
  type ImageContentType,
} from "@/domain/upload";
import { KeyedMutex } from "@/lib/keyed-mutex";

export interface StoredImage {
  /** Nome gerado do arquivo (também o ID da imagem no ProductInput). */
  id: string;
  productId: string;
  /** URI relativa guardada no ProductInput (ex.: outputs/uploads/prod_x/img_y.jpg). */
  uri: string;
  contentType: ImageContentType;
  size: number;
}

/**
 * Contrato usado pela aplicação (Lote 7): LocalUploadStore (disco) ou CloudUploadStore
 * (Supabase Storage + tabela product_assets). Sempre por IDs gerados, nunca caminhos do browser.
 */
export interface UploadStore {
  save(productId: string, file: { bytes: Uint8Array; size: number; declaredType: string }): Promise<StoredImage>;
  list(productId: string): Promise<StoredImage[]>;
  resolve(productId: string, imageIds: readonly string[]): Promise<StoredImage[]>;
  read(productId: string, imageId: string): Promise<{ bytes: Uint8Array; contentType: ImageContentType } | undefined>;
  remove(productId: string, imageId: string): Promise<boolean>;
}

export class InvalidUploadPathError extends Error {
  override name = "InvalidUploadPathError";
}

/**
 * Imagens do produto em disco local: `<rootDir>/<productId>/<img_uuid>.<ext>`.
 * - Nome sempre gerado aqui; o nome original é descartado.
 * - productId e nome do arquivo são validados por regex E o caminho resolvido precisa ficar
 *   dentro de rootDir (defesa dupla contra path traversal).
 * - Uploads do mesmo produto são serializados para o limite de quantidade valer.
 */
export class LocalUploadStore implements UploadStore {
  private readonly root: string;
  private readonly locks = new KeyedMutex();

  constructor(private readonly rootDir: string) {
    this.root = resolve(rootDir);
  }

  async save(productId: string, file: { bytes: Uint8Array; size: number; declaredType: string }): Promise<StoredImage> {
    const dir = this.productDir(productId);
    const { contentType, extension } = validateImageUpload(file);
    return this.locks.run(productId, async () => {
      if ((await this.list(productId)).length >= UPLOAD_LIMITS.maxImagesPerProduct) {
        throw new UploadValidationError("limit_reached");
      }
      await mkdir(dir, { recursive: true });
      const id = `img_${randomUUID()}.${extension}`;
      await writeFile(this.filePath(productId, id), file.bytes, { flag: "wx" });
      return this.describe(productId, id, contentType, file.bytes.length);
    });
  }

  async list(productId: string): Promise<StoredImage[]> {
    const dir = this.productDir(productId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const images: StoredImage[] = [];
    for (const name of names.sort()) {
      const contentType = contentTypeForStoredName(name);
      if (!contentType) continue;
      const info = await stat(join(dir, name));
      images.push(this.describe(productId, name, contentType, info.size));
    }
    return images;
  }

  /** Imagens pedidas que existem de fato (na ordem pedida). IDs desconhecidos são ignorados. */
  async resolve(productId: string, imageIds: readonly string[]): Promise<StoredImage[]> {
    const available = new Map((await this.list(productId)).map((i) => [i.id, i]));
    return imageIds.flatMap((id) => {
      const image = available.get(id);
      return image ? [image] : [];
    });
  }

  async read(productId: string, imageId: string): Promise<{ bytes: Buffer; contentType: ImageContentType } | undefined> {
    const path = this.filePath(productId, imageId);
    const contentType = contentTypeForStoredName(imageId);
    if (!contentType) return undefined;
    try {
      return { bytes: await readFile(path), contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(productId: string, imageId: string): Promise<boolean> {
    const path = this.filePath(productId, imageId);
    return this.locks.run(productId, async () => {
      try {
        await stat(path);
      } catch {
        return false;
      }
      await rm(path);
      return true;
    });
  }

  private describe(productId: string, id: string, contentType: ImageContentType, size: number): StoredImage {
    const uri = [this.rootDir.replaceAll("\\", "/").replace(/\/+$/, ""), productId, id].join("/");
    return { id, productId, uri, contentType, size };
  }

  private productDir(productId: string): string {
    if (!SAFE_PRODUCT_ID.test(productId)) throw new InvalidUploadPathError("ID de produto inválido");
    return this.contained(join(this.root, productId));
  }

  private filePath(productId: string, imageId: string): string {
    if (!STORED_IMAGE_NAME.test(imageId)) throw new InvalidUploadPathError("Nome de imagem inválido");
    return this.contained(join(this.productDir(productId), imageId));
  }

  private contained(path: string): string {
    const full = resolve(path);
    if (!full.startsWith(this.root + sep)) throw new InvalidUploadPathError("Caminho fora da pasta de uploads");
    return full;
  }
}
