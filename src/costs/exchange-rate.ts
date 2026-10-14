import { ExchangeRateSchema, type ExchangeRate } from "@/domain/cost";

/**
 * Fonte da cotação USD→BRL. Assíncrona para permitir, no futuro, buscar de uma API
 * sem alterar os consumidores. V1: valor estático vindo de env/config.
 */
export interface ExchangeRateProvider {
  getUsdBrl(): Promise<ExchangeRate>;
}

export class StaticExchangeRateProvider implements ExchangeRateProvider {
  private readonly rate: ExchangeRate;

  constructor(rate: ExchangeRate) {
    this.rate = ExchangeRateSchema.parse(rate);
  }

  async getUsdBrl(): Promise<ExchangeRate> {
    return this.rate;
  }
}
