import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Layout dos renders:  <rendersDir>/<campaignId>/<creativeId>/v<N>/{final.mp4, manifest.json}
 * Cada render cria uma pasta de versão NOVA (mkdir sem recursive: falha se já existir), então
 * nada é sobrescrito nem apagado. Os IDs são validados antes de virar caminho.
 */

export const SAFE_ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const RENDER_ID = /^v[1-9]\d{0,3}$/;
export const FINAL_FILE = "final.mp4";
export const PARTIAL_FILE = "final.partial.mp4";
export const MANIFEST_FILE = "manifest.json";
export const MAX_RENDER_VERSION = 9999;

export class InvalidRenderPathError extends Error {
  override name = "InvalidRenderPathError";
}

export function renderIdFor(version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > MAX_RENDER_VERSION) {
    throw new InvalidRenderPathError(`Versão de render inválida: ${version}`);
  }
  return `v${version}`;
}

/** Pasta de uma versão. Lança se algum ID for inválido ou o caminho escapar da raiz. */
export function renderDir(rendersDir: string, campaignId: string, creativeId: string, renderId: string): string {
  if (!SAFE_ENTITY_ID.test(campaignId) || !SAFE_ENTITY_ID.test(creativeId) || !RENDER_ID.test(renderId)) {
    throw new InvalidRenderPathError("Identificador de render inválido");
  }
  const root = resolve(rendersDir);
  const dir = resolve(root, campaignId, creativeId, renderId);
  if (!dir.startsWith(root + sep)) throw new InvalidRenderPathError("Caminho de render fora da pasta de renders");
  return dir;
}

/** Caminho relativo (posix) para guardar no job/manifest. */
export function relativeRenderUri(rendersDir: string, campaignId: string, creativeId: string, renderId: string, file: string): string {
  return [rendersDir.replaceAll("\\", "/").replace(/\/+$/, ""), campaignId, creativeId, renderId, file].join("/");
}

/** Reserva a primeira versão livre a partir de `preferred` (criação atômica da pasta). */
export async function allocateRenderDir(
  rendersDir: string,
  campaignId: string,
  creativeId: string,
  preferred = 1,
): Promise<{ renderId: string; dir: string }> {
  const parent = join(resolve(rendersDir), campaignId, creativeId);
  renderDir(rendersDir, campaignId, creativeId, renderIdFor(Math.max(1, preferred))); // valida IDs
  await mkdir(parent, { recursive: true });
  for (let version = Math.max(1, preferred); version <= MAX_RENDER_VERSION; version++) {
    const renderId = renderIdFor(version);
    const dir = renderDir(rendersDir, campaignId, creativeId, renderId);
    try {
      await mkdir(dir);
      return { renderId, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new InvalidRenderPathError("Sem versões de render livres");
}
