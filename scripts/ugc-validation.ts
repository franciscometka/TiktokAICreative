/** Infra compartilhada dos scripts de validação AI UGC REAL (Lote 5.4). Sem rede aqui. */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { GoogleUgcReadiness } from "../src/config/ugc-readiness";
import { writeFileAtomic } from "../src/storage/atomic-file";

/** Intenção durável: gravada ANTES da rede; status nunca volta para permitir reenvio automático. */
export const ValidationIntentSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  stage: z.enum(["ugc_reference", "ugc_video"]),
  model: z.string(),
  status: z.enum(["preparing", "submitting", "submitted", "succeeded", "failed", "uncertain"]),
  maxCostUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  inputHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  operationId: z.string().optional(),
  requestId: z.string().optional(),
  error: z.string().optional(),
  outputUri: z.string().optional(),
  actualCostUsd: z.number().nonnegative().optional(),
  requestedDurationSeconds: z.number().optional(),
  referenceIntentId: z.string().optional(),
  approvedAt: z.string().optional(),
  inputs: z.record(z.string(), z.string()).default({}),
});
export type ValidationIntent = z.infer<typeof ValidationIntentSchema>;

export class ValidationIntentStore {
  constructor(private readonly dir: string) {}
  private path(id: string) { return join(this.dir, `${ValidationIntentSchema.shape.id.parse(id)}.json`); }
  async save(intent: ValidationIntent): Promise<ValidationIntent> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.path(intent.id), `${JSON.stringify(ValidationIntentSchema.parse(intent), null, 2)}\n`);
    return intent;
  }
  async get(id: string): Promise<ValidationIntent | undefined> {
    const path = this.path(id);
    return existsSync(path) ? ValidationIntentSchema.parse(JSON.parse(await readFile(path, "utf8"))) : undefined;
  }
  async list(): Promise<ValidationIntent[]> {
    if (!existsSync(this.dir)) return [];
    const files = (await readdir(this.dir)).filter(name => name.endsWith(".json"));
    return Promise.all(files.map(async name => ValidationIntentSchema.parse(JSON.parse(await readFile(join(this.dir, name), "utf8")))));
  }
  /** Intenções sem desfecho: bloqueiam qualquer novo envio da mesma etapa. */
  async unresolved(stage: ValidationIntent["stage"]): Promise<ValidationIntent[]> {
    return (await this.list()).filter(intent => intent.stage === stage && !["succeeded", "failed"].includes(intent.status));
  }
}

export function printReadiness(readiness: GoogleUgcReadiness): void {
  console.log(`Readiness Google AI UGC: ${readiness.ready ? "PRONTO" : "BLOQUEADO"}`);
  for (const check of readiness.checks) console.log(`  [${check.ok ? "ok" : "--"}] ${check.label}: ${check.detail}`);
}

export const usd = (value: number) => `US$${value.toFixed(4)}`;
