import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Lote 7: armazenamento de arquivos atrás de UMA interface. O domínio/pipeline não conhece o
 * Supabase Storage. Implementações: LocalAssetStore (dev/teste) e SupabaseAssetStore (cloud).
 *
 * Caminhos são CHAVES lógicas validadas (`users/{userId}/...`), nunca vindas do browser.
 * URL assinada é gerada sob demanda e nunca persistida (o banco guarda bucket + path).
 */

export interface StoredObject {
  bucket: string;
  path: string;
  contentType: string;
  size: number;
}

export interface SignedUpload {
  /** URL para o browser enviar o arquivo DIRETO ao storage (PUT), sem passar pela API. */
  url: string;
  path: string;
  /** Validade da autorização de upload. */
  expiresInSeconds: number;
}

export interface AssetStore {
  readonly kind: "local" | "supabase";
  readonly bucket: string;
  put(path: string, data: Uint8Array, options: { contentType: string; upsert?: boolean }): Promise<StoredObject>;
  get(path: string): Promise<Uint8Array | undefined>;
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** URL temporária de leitura (privado por padrão). */
  getSignedUrl(path: string, options: { expiresInSeconds: number; downloadName?: string }): Promise<string>;
  /** Autoriza UM upload direto para `path` (o browser nunca recebe a service role). */
  createSignedUpload(path: string): Promise<SignedUpload>;
  /** Baixa para um arquivo local (workspace temporário do worker). */
  downloadToTemp(path: string, destination: string): Promise<string>;
  /** Readiness barato (sem custo de API paga). */
  ping(): Promise<boolean>;
}

export class AssetPathError extends Error {
  override name = "AssetPathError";
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USER_PREFIX = /^users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//;

/** Chave de storage segura: `users/{uuid}/...`, só segmentos simples, sem `..`, sem barra inicial. */
export function assertSafeStoragePath(path: string): string {
  if (!USER_PREFIX.test(path)) throw new AssetPathError("Caminho de storage fora de users/{userId}/");
  const segments = path.split("/");
  if (segments.length > 12 || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) {
    throw new AssetPathError("Caminho de storage inválido");
  }
  return path;
}

/** Dono do caminho (o userId do prefixo). Usado para conferir ownership antes de assinar. */
export function storagePathOwner(path: string): string {
  assertSafeStoragePath(path);
  return path.split("/")[1]!;
}

/**
 * Implementação local (dev/teste): arquivos em `rootDir/<bucket>/<path>`. URL "assinada" =
 * HMAC com validade, servida pela própria API local (`/v1/local-assets/...`).
 */
export class LocalAssetStore implements AssetStore {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    readonly bucket: string,
    private readonly signing: { secret: string; baseUrl: string; now?: () => number },
  ) {
    if (signing.secret.length < 16) throw new Error("LocalAssetStore precisa de um segredo de assinatura (>= 16 caracteres)");
    this.root = resolve(rootDir, bucket);
  }

  private file(path: string): string {
    const full = resolve(this.root, assertSafeStoragePath(path));
    if (!full.startsWith(this.root + sep)) throw new AssetPathError("Caminho fora do storage local");
    return full;
  }

  async put(path: string, data: Uint8Array, options: { contentType: string; upsert?: boolean }): Promise<StoredObject> {
    const target = this.file(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: options.upsert ? "w" : "wx" });
    await writeFile(`${target}.type`, options.contentType, { flag: "w" });
    return { bucket: this.bucket, path, contentType: options.contentType, size: data.byteLength };
  }

  async get(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.file(path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async contentType(path: string): Promise<string | undefined> {
    try { return (await readFile(`${this.file(path)}.type`, "utf8")).trim(); } catch { return undefined; }
  }

  async delete(path: string): Promise<boolean> {
    const target = this.file(path);
    if (!(await this.exists(path))) return false;
    await rm(target, { force: true });
    await rm(`${target}.type`, { force: true });
    return true;
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await stat(this.file(path))).isFile();
    } catch {
      return false;
    }
  }

  private sign(path: string, exp: number, op: "read" | "write"): string {
    return createHmac("sha256", this.signing.secret).update(`${op}\n${this.bucket}\n${path}\n${exp}`).digest("base64url");
  }

  async getSignedUrl(path: string, options: { expiresInSeconds: number; downloadName?: string }): Promise<string> {
    assertSafeStoragePath(path);
    const exp = Math.floor((this.signing.now?.() ?? Date.now()) / 1000) + options.expiresInSeconds;
    const query = new URLSearchParams({ exp: String(exp), sig: this.sign(path, exp, "read") });
    if (options.downloadName) query.set("download", options.downloadName);
    return `${this.signing.baseUrl}/v1/local-assets/${path}?${query}`;
  }

  async createSignedUpload(path: string): Promise<SignedUpload> {
    assertSafeStoragePath(path);
    const expiresInSeconds = 600;
    const exp = Math.floor((this.signing.now?.() ?? Date.now()) / 1000) + expiresInSeconds;
    const query = new URLSearchParams({ exp: String(exp), sig: this.sign(path, exp, "write") });
    return { url: `${this.signing.baseUrl}/v1/local-assets/${path}?${query}`, path, expiresInSeconds };
  }

  /** Confere a assinatura de uma URL local (rota de dev da API). */
  verify(path: string, exp: string | null, sig: string | null, op: "read" | "write"): boolean {
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < Math.floor((this.signing.now?.() ?? Date.now()) / 1000)) return false;
    try { assertSafeStoragePath(path); } catch { return false; }
    const expected = Buffer.from(this.sign(path, Number(exp), op));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async downloadToTemp(path: string, destination: string): Promise<string> {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.file(path), destination);
    return destination;
  }

  async ping(): Promise<boolean> {
    await mkdir(this.root, { recursive: true });
    return true;
  }
}

/** Raiz de um arquivo local qualquer do store (só para testes/diagnóstico). */
export function localObjectPath(rootDir: string, bucket: string, path: string): string {
  return join(resolve(rootDir, bucket), assertSafeStoragePath(path));
}
