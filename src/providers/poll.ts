import { ProviderError, type ProviderJobRef, type ProviderJobStatus } from "./types";

export interface PollOptions {
  /** Limite rígido de consultas — nunca polling infinito. */
  maxPolls: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_POLL_OPTIONS: PollOptions = { maxPolls: 120, intervalMs: 5_000 };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Consulta o status até concluir ou falhar. Lança ProviderError em falha/timeout. */
export async function waitForCompletion(
  getStatus: (ref: ProviderJobRef) => Promise<ProviderJobStatus>,
  ref: ProviderJobRef,
  options: PollOptions = DEFAULT_POLL_OPTIONS,
): Promise<ProviderJobStatus> {
  const sleep = options.sleep ?? defaultSleep;
  for (let poll = 1; poll <= options.maxPolls; poll++) {
    const status = await getStatus(ref);
    if (status.state === "succeeded") return status;
    if (status.state === "failed") {
      throw new ProviderError(status.error ?? "Geração falhou", ref.providerJobId, status.billedUsage, status.diagnostic);
    }
    if (poll < options.maxPolls) await sleep(options.intervalMs);
  }
  throw new ProviderError(`Timeout após ${options.maxPolls} consultas de status`, ref.providerJobId);
}
