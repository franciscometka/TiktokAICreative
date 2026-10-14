import { join } from "node:path";
import type { CostLedger } from "@/costs/ledger";
import { GenerationCostSchema, type GenerationCost } from "@/domain/cost";
import { CorruptedDataError } from "./atomic-file";
import { JsonlFile } from "./jsonl-file";

/**
 * Ledger de custo real persistido em <dataDir>/ledger.jsonl (append-only, fsync por registro).
 * Carregado uma vez por processo; leituras servem da memória, escritas vão primeiro ao disco.
 */
export class FileCostLedger implements CostLedger {
  private readonly file: JsonlFile<GenerationCost>;
  private entries: GenerationCost[] | undefined;
  private loading: Promise<GenerationCost[]> | undefined;

  constructor(dataDir: string, onWarning?: (message: string) => void) {
    this.file = new JsonlFile(join(dataDir, "ledger.jsonl"), GenerationCostSchema, onWarning);
  }

  async record(entry: GenerationCost): Promise<void> {
    const entries = await this.load();
    const parsed = GenerationCostSchema.parse(entry);
    if (entries.some((e) => e.id === parsed.id)) throw new Error(`Registro de custo duplicado: ${parsed.id}`);
    await this.file.append(parsed);
    entries.push(Object.freeze(parsed));
  }

  async list(filter: { campaignId?: string; jobId?: string | null } = {}): Promise<readonly GenerationCost[]> {
    const entries = await this.load();
    return entries.filter(
      (e) =>
        (filter.campaignId === undefined || e.campaignId === filter.campaignId) &&
        (filter.jobId === undefined || e.jobId === filter.jobId),
    );
  }

  private load(): Promise<GenerationCost[]> {
    if (this.entries) return Promise.resolve(this.entries);
    this.loading ??= this.file.readAll().then((all) => {
      const ids = new Set<string>();
      for (const e of all) {
        if (ids.has(e.id)) throw new CorruptedDataError(`ledger.jsonl: ID duplicado ${e.id}`);
        ids.add(e.id);
      }
      this.entries = all.map((e) => Object.freeze(e));
      return this.entries;
    });
    return this.loading;
  }
}
