import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Disco TEMPORÁRIO do worker: `{root}/{jobId}/`. Fonte de verdade é o Storage; aqui só ficam
 * cópias baixadas (hidratação) e arquivos recém-gerados antes do upload.
 *
 * Limpeza: ao concluir a tarefa, ao falhar (depois que os arquivos novos já subiram) e, na
 * inicialização, diretórios abandonados mais velhos que o limite. Um job ainda em andamento em
 * outro worker nunca depende deste disco: ele reidrata do Storage.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class TempWorkspaceError extends Error {
  override name = "TempWorkspaceError";
}

export function workspaceDir(root: string, key: string): string {
  if (!SAFE_ID.test(key)) throw new TempWorkspaceError("ID inválido para workspace temporário");
  const base = resolve(root);
  const dir = resolve(base, key);
  if (!dir.startsWith(base + sep)) throw new TempWorkspaceError("Workspace fora da raiz temporária");
  return dir;
}

export async function createWorkspace(root: string, key: string): Promise<string> {
  const dir = workspaceDir(root, key);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeWorkspace(root: string, key: string): Promise<void> {
  await rm(workspaceDir(root, key), { recursive: true, force: true, maxRetries: 3 });
}

/** Apaga workspaces abandonados (mtime mais velho que `maxAgeMs`), exceto os de `keep`. */
export async function cleanupStaleWorkspaces(root: string, options: { maxAgeMs: number; keep?: ReadonlySet<string>; now?: number }): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(resolve(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  for (const name of names) {
    if (!SAFE_ID.test(name) || options.keep?.has(name)) continue;
    const dir = join(resolve(root), name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory() || now - info.mtimeMs < options.maxAgeMs) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    removed.push(name);
  }
  return removed;
}
