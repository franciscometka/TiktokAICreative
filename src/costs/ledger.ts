import { COST_CATEGORIES, GenerationCostSchema, type CostCategory, type GenerationCost } from "@/domain/cost";
import { roundBrl, roundUsd } from "@/lib/money";

/**
 * Registro de custo EFETIVO. Append-only: não há update nem delete.
 * Toda tentativa (inclusive falhas faturadas e regenerações descartadas) entra aqui.
 */
export interface CostLedger {
  record(entry: GenerationCost): Promise<void>;
  list(filter?: { campaignId?: string; jobId?: string | null }): Promise<readonly GenerationCost[]>;
}

export class InMemoryCostLedger implements CostLedger {
  private readonly entries: GenerationCost[] = [];

  async record(entry: GenerationCost): Promise<void> {
    const parsed = GenerationCostSchema.parse(entry);
    if (this.entries.some((e) => e.id === parsed.id)) {
      throw new Error(`Registro de custo duplicado: ${parsed.id}`);
    }
    this.entries.push(Object.freeze(parsed));
  }

  async list(filter: { campaignId?: string; jobId?: string | null } = {}): Promise<readonly GenerationCost[]> {
    return this.entries.filter(
      (e) =>
        (filter.campaignId === undefined || e.campaignId === filter.campaignId) &&
        (filter.jobId === undefined || e.jobId === filter.jobId),
    );
  }
}

export interface ActualCostSummary {
  kind: "actual";
  totalUsd: number;
  totalBrl: number;
  /** Custo de tentativas que estão no vídeo final (ou ainda sem vínculo a tentativa). */
  keptBrl: number;
  /** Custo de tentativas descartadas ou que falharam — continua sendo custo real. */
  discardedBrl: number;
  byCategoryBrl: Record<CostCategory, number>;
  entryCount: number;
  /** true se algum registro foi simulado por mock (nenhum dinheiro gasto). */
  includesSimulated: boolean;
}

/** Soma PURA dos custos efetivos. `discardedAttemptIds` vem do estado do job. */
export function summarizeActualCosts(
  entries: readonly GenerationCost[],
  discardedAttemptIds: ReadonlySet<string> = new Set(),
): ActualCostSummary {
  const byCategory = Object.fromEntries(COST_CATEGORIES.map((c) => [c, 0])) as Record<CostCategory, number>;
  let totalUsd = 0;
  let totalBrl = 0;
  let discardedBrl = 0;

  for (const e of entries) {
    totalUsd += e.costUsd;
    totalBrl += e.costBrl;
    byCategory[e.category] += e.costBrl;
    if (e.attemptId !== null && discardedAttemptIds.has(e.attemptId)) {
      discardedBrl += e.costBrl;
    }
  }

  return {
    kind: "actual",
    totalUsd: roundUsd(totalUsd),
    totalBrl: roundBrl(totalBrl),
    keptBrl: roundBrl(totalBrl - discardedBrl),
    discardedBrl: roundBrl(discardedBrl),
    byCategoryBrl: Object.fromEntries(
      COST_CATEGORIES.map((c) => [c, roundBrl(byCategory[c])]),
    ) as Record<CostCategory, number>,
    entryCount: entries.length,
    includesSimulated: entries.some((e) => e.simulated),
  };
}
