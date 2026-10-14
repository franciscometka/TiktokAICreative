import { mkdir, open, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { CorruptedDataError, readTextIfExists } from "./atomic-file";

/**
 * Arquivo JSON Lines append-only (um registro por linha).
 * - Cada append grava a linha inteira e faz fsync antes de resolver.
 * - Appends são serializados dentro do processo (fila).
 * - Uma linha final SEM "\n" é uma escrita interrompida (o append nunca confirmou):
 *   é ignorada na leitura e removida antes do próximo append.
 * - Uma linha completa inválida é corrupção real → CorruptedDataError (nunca é ignorada).
 */
export class JsonlFile<T> {
  private queue: Promise<unknown> = Promise.resolve();
  private recovered = false;

  constructor(
    readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly onWarning: (message: string) => void = (m) => console.warn(m),
  ) {}

  append(record: T): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(this.schema.parse(record))}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    const task = this.queue.then(async () => {
      await this.recoverTornTail();
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try {
        await handle.write(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async readAll(): Promise<T[]> {
    const content = await readTextIfExists(this.path);
    if (!content) return [];
    const lines = content.split("\n");
    const tail = lines.pop();
    if (tail !== undefined && tail.length > 0) {
      this.onWarning(`[jsonl] ${this.path}: última linha incompleta ignorada (${tail.length} bytes)`);
    }
    return lines.map((line, index) => {
      try {
        return this.schema.parse(JSON.parse(line));
      } catch (error) {
        throw new CorruptedDataError(
          `${this.path}: linha ${index + 1} inválida (${error instanceof Error ? error.message.slice(0, 200) : "?"})`,
        );
      }
    });
  }

  private async recoverTornTail(): Promise<void> {
    if (this.recovered) return;
    const content = await readTextIfExists(this.path);
    if (content && !content.endsWith("\n")) {
      const keep = Buffer.byteLength(content.slice(0, content.lastIndexOf("\n") + 1), "utf8");
      this.onWarning(`[jsonl] ${this.path}: removendo escrita interrompida no final do arquivo`);
      await truncate(this.path, keep);
    }
    this.recovered = true;
  }
}
