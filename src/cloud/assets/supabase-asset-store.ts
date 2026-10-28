import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertSafeStoragePath, type AssetStore, type SignedUpload, type StoredObject } from "./asset-store";

/**
 * Supabase Storage via REST (sem SDK): o ÚNICO lugar que conhece a API do Storage.
 * A service role fica SÓ neste objeto (API/worker); nunca é logada nem devolvida.
 * Bucket privado: leitura pelo browser só por URL assinada com validade curta.
 */

export class StorageError extends Error {
  override name = "StorageError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  fetch?: typeof fetch;
  /** Timeout por chamada (ms). Uploads grandes de render usam o mesmo limite × 10. */
  timeoutMs?: number;
}

const encodePath = (path: string) => assertSafeStoragePath(path).split("/").map(encodeURIComponent).join("/");

export class SupabaseAssetStore implements AssetStore {
  readonly kind = "supabase" as const;
  readonly bucket: string;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SupabaseStorageOptions) {
    this.bucket = options.bucket;
    this.base = `${options.url.replace(/\/+$/, "")}/storage/v1`;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.serviceRoleKey}`, apikey: this.options.serviceRoleKey, ...extra };
  }

  private async call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    try {
      return await this.fetcher(`${this.base}${path}`, {
        method,
        headers: this.headers(init.headers),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      // Mensagem genérica: nunca repassa URL com token nem headers.
      throw new StorageError(`Storage indisponível (${method}): ${error instanceof Error ? error.name : "erro de rede"}`);
    }
  }

  private async fail(response: Response, action: string): Promise<never> {
    const text = (await response.text().catch(() => "")).slice(0, 200).replace(/token=[^&\s"]+/g, "token=[redacted]");
    throw new StorageError(`Storage recusou ${action} (HTTP ${response.status})${text ? `: ${text}` : ""}`, response.status);
  }

  async put(path: string, data: Uint8Array, options: { contentType: string; upsert?: boolean }): Promise<StoredObject> {
    const response = await this.call("POST", `/object/${this.bucket}/${encodePath(path)}`, {
      body: data as unknown as BodyInit,
      headers: { "Content-Type": options.contentType, "x-upsert": options.upsert ? "true" : "false", "Cache-Control": "private, max-age=0" },
      timeoutMs: this.timeoutMs * 10,
    });
    if (!response.ok) await this.fail(response, "o upload");
    return { bucket: this.bucket, path, contentType: options.contentType, size: data.byteLength };
  }

  async get(path: string): Promise<Uint8Array | undefined> {
    const response = await this.call("GET", `/object/${this.bucket}/${encodePath(path)}`, { timeoutMs: this.timeoutMs * 10 });
    if (response.status === 404 || response.status === 400) return undefined;
    if (!response.ok) await this.fail(response, "o download");
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(path: string): Promise<boolean> {
    const response = await this.call("DELETE", `/object/${this.bucket}`, {
      body: JSON.stringify({ prefixes: [assertSafeStoragePath(path)] }),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) await this.fail(response, "a remoção");
    const removed = (await response.json().catch(() => [])) as unknown[];
    return Array.isArray(removed) && removed.length > 0;
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.call("HEAD", `/object/${this.bucket}/${encodePath(path)}`);
    if (response.ok) return true;
    if (response.status === 404 || response.status === 400) return false;
    return this.fail(response, "a consulta");
  }

  async getSignedUrl(path: string, options: { expiresInSeconds: number; downloadName?: string }): Promise<string> {
    const response = await this.call("POST", `/object/sign/${this.bucket}/${encodePath(path)}`, {
      body: JSON.stringify({ expiresIn: options.expiresInSeconds }),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) await this.fail(response, "a URL assinada");
    const body = (await response.json()) as { signedURL?: string };
    if (!body.signedURL) throw new StorageError("Storage não devolveu URL assinada");
    const url = new URL(`${this.base}${body.signedURL.startsWith("/") ? "" : "/"}${body.signedURL}`);
    if (options.downloadName) url.searchParams.set("download", options.downloadName);
    return url.toString();
  }

  async createSignedUpload(path: string): Promise<SignedUpload> {
    const response = await this.call("POST", `/object/upload/sign/${this.bucket}/${encodePath(path)}`, { headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) await this.fail(response, "a autorização de upload");
    const body = (await response.json()) as { url?: string };
    if (!body.url) throw new StorageError("Storage não devolveu URL de upload");
    // URL de upload assinada vale 2h no Supabase; a API ainda confere o arquivo ao concluir.
    return { url: `${this.base}${body.url.startsWith("/") ? "" : "/"}${body.url}`, path, expiresInSeconds: 7200 };
  }

  async downloadToTemp(path: string, destination: string): Promise<string> {
    const data = await this.get(path);
    if (!data) throw new StorageError(`Arquivo ausente no storage: ${path}`, 404);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
    return destination;
  }

  async ping(): Promise<boolean> {
    const response = await this.call("GET", `/bucket/${this.bucket}`, { timeoutMs: 5_000 });
    return response.ok;
  }
}
