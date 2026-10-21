import { assertSafeStoragePath } from "./asset-store";

/**
 * Mapa entre os arquivos locais do pipeline (URIs RELATIVAS ao cwd, como hoje: `outputs/ugc/...`)
 * e as chaves do Storage. Estrutura (D101):
 *
 *   users/{userId}/uploads/{productId|avatarId}/{img}         fotos do produto e do avatar
 *   users/{userId}/projects/{campaignId}/references/...       referências AI UGC
 *   users/{userId}/projects/{campaignId}/clips/...            clipes gerados
 *   users/{userId}/projects/{campaignId}/audio/...            narrações / áudio mestre
 *   users/{userId}/projects/{campaignId}/renders/...          MP4 finais + manifest
 *
 * O documento do job continua guardando a URI local relativa (compatível com o modo local); o
 * banco guarda bucket + path de cada arquivo em `generated_assets`/`product_assets`.
 */

export interface DataDirs {
  uploadsDir: string;
  ugcDir: string;
  videosDir: string;
  audioDir: string;
  rendersDir: string;
}

export type AssetKind = "upload" | "reference" | "clip" | "audio" | "render";

const KIND_FOLDER: Record<Exclude<AssetKind, "upload">, string> = { reference: "references", clip: "clips", audio: "audio", render: "renders" };

const norm = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

export class LayoutError extends Error {
  override name = "LayoutError";
}

export interface ClassifiedUri {
  kind: AssetKind;
  /** productId/avatarId (upload) ou campaignId (demais). */
  ownerId: string;
  /** Resto do caminho depois do dono. */
  rest: string;
}

export function classifyLocalUri(uri: string, dirs: DataDirs): ClassifiedUri | undefined {
  const u = norm(uri);
  if (!u || u.startsWith("/") || /^[A-Za-z]:/.test(u) || u.split("/").some((s) => s === ".." || s === "")) return undefined;
  const roots: [AssetKind, string][] = [
    ["upload", norm(dirs.uploadsDir)], ["reference", norm(dirs.ugcDir)], ["clip", norm(dirs.videosDir)],
    ["audio", norm(dirs.audioDir)], ["render", norm(dirs.rendersDir)],
  ];
  for (const [kind, root] of roots) {
    if (!u.startsWith(`${root}/`)) continue;
    const [ownerId, ...rest] = u.slice(root.length + 1).split("/");
    if (!ownerId || rest.length === 0) return undefined;
    return { kind, ownerId, rest: rest.join("/") };
  }
  return undefined;
}

export function storageKeyForLocalUri(userId: string, uri: string, dirs: DataDirs): { key: string; kind: AssetKind; ownerId: string } {
  const c = classifyLocalUri(uri, dirs);
  if (!c) throw new LayoutError("Arquivo fora das pastas de dados conhecidas");
  const key = c.kind === "upload"
    ? `users/${userId}/uploads/${c.ownerId}/${c.rest}`
    : `users/${userId}/projects/${c.ownerId}/${KIND_FOLDER[c.kind]}/${c.rest}`;
  return { key: assertSafeStoragePath(key), kind: c.kind, ownerId: c.ownerId };
}

export function uploadLocalUri(dirs: DataDirs, ownerId: string, fileName: string): string {
  return `${norm(dirs.uploadsDir)}/${ownerId}/${fileName}`;
}

/** Pastas de projeto (onde o worker procura arquivos NOVOS depois de uma tarefa). */
export function projectDirs(dirs: DataDirs, campaignId: string): string[] {
  return [dirs.ugcDir, dirs.videosDir, dirs.audioDir, dirs.rendersDir].map((d) => `${norm(d)}/${campaignId}`);
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", json: "application/json",
};

export function contentTypeForPath(path: string): string {
  return CONTENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
