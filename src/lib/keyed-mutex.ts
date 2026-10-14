/**
 * Exclusão mútua por chave dentro do processo. Serializa operações da mesma campanha
 * (ex.: duas aprovações simultâneas não podem passar juntas pelo limite da campanha).
 * Não protege contra DOIS processos usando o mesmo diretório de dados.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
