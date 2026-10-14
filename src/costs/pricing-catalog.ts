import { ProviderPricingSchema, type PricingUnit, type ProviderPricing } from "@/domain/cost";
import type { PricingRef } from "@/domain/quality";

export class PricingNotFoundError extends Error {
  override name = "PricingNotFoundError";
}

/**
 * Fonte de preços. V1: tabela estática (config/pricing.ts).
 * Futuro: implementação que lê de banco/API sem mudar quem consome.
 */
export interface PricingCatalog {
  /** Entrada para um provider/modelo e unidade específica (ex.: LLM input vs output). */
  require(ref: PricingRef, unit: PricingUnit): ProviderPricing;
  /** Entrada única de um provider/modelo de mídia (unidade definida pelo provider). */
  requireOne(ref: PricingRef): ProviderPricing;
  list(): readonly ProviderPricing[];
}

export class StaticPricingCatalog implements PricingCatalog {
  private readonly entries: readonly ProviderPricing[];

  constructor(entries: readonly ProviderPricing[]) {
    this.entries = entries.map((e) => Object.freeze(ProviderPricingSchema.parse(e)));
    const keys = new Set<string>();
    for (const e of this.entries) {
      const key = `${e.provider}|${e.model}|${e.unit}`;
      if (keys.has(key)) throw new Error(`Preço duplicado no catálogo: ${key}`);
      keys.add(key);
    }
  }

  require(ref: PricingRef, unit: PricingUnit): ProviderPricing {
    const found = this.entries.find(
      (e) => e.provider === ref.provider && e.model === ref.model && e.unit === unit,
    );
    if (!found) {
      throw new PricingNotFoundError(`Sem preço para ${ref.provider}/${ref.model} (${unit})`);
    }
    return found;
  }

  requireOne(ref: PricingRef): ProviderPricing {
    const found = this.entries.filter((e) => e.provider === ref.provider && e.model === ref.model);
    if (found.length !== 1 || !found[0]) {
      throw new PricingNotFoundError(
        `Esperado exatamente 1 preço para ${ref.provider}/${ref.model}, encontrado ${found.length}`,
      );
    }
    return found[0];
  }

  list(): readonly ProviderPricing[] {
    return this.entries;
  }
}
