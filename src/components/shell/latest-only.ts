/**
 * L8.8.1 — polling "só o último vale": cada `load()` cancela a requisição anterior (AbortController)
 * e um contador monotônico descarta qualquer resposta que chegue depois de uma mais nova — mesmo se
 * o `fetch` ignorar o abort. Nunca há duas leituras concorrentes valendo; erro mantém o último valor.
 */
export class LatestOnly<T> {
  private seq = 0;
  private controller: AbortController | null = null;

  constructor(private readonly fetcher: (signal: AbortSignal) => Promise<T | null>, private readonly onValue: (value: T) => void) {}

  async load(): Promise<void> {
    const id = ++this.seq;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const value = await this.fetcher(controller.signal);
      if (id !== this.seq || controller.signal.aborted || value === null) return;
      this.onValue(value);
    } catch {
      // Sem rede/abortada: mantém o último status (o próximo ciclo tenta de novo).
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Para de vez (unmount): nada que chegar depois é aplicado. */
  stop(): void {
    this.seq++;
    this.controller?.abort();
    this.controller = null;
  }

  get inFlight(): boolean {
    return this.controller !== null;
  }
}
