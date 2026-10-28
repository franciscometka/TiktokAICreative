import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Escrita atômica de arquivo inteiro: grava em arquivo temporário no MESMO diretório,
 * faz fsync e renomeia por cima do destino. Um leitor nunca vê arquivo pela metade:
 * ou vê a versão antiga, ou a nova.
 */

export const TEMP_SUFFIX = ".tmp";

/** No Windows, antivírus/indexador podem segurar o arquivo por instantes (EPERM/EBUSY/EACCES). */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_ATTEMPTS || !code || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}${TEMP_SUFFIX}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** Lê um arquivo de texto; `undefined` se não existir. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Remove temporários órfãos deixados por um processo que caiu no meio de uma escrita. */
export async function cleanupTempFiles(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  const temps = names.filter((n) => n.endsWith(TEMP_SUFFIX));
  await Promise.all(temps.map((n) => unlink(join(dir, n)).catch(() => undefined)));
  return temps.length;
}

export class CorruptedDataError extends Error {
  override name = "CorruptedDataError";
}
