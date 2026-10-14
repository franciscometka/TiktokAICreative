import { join } from "node:path";
import { LlmCallRecordSchema, type LlmCallRecord } from "@/domain/llm";
import { JsonlFile } from "./jsonl-file";

/**
 * Registro de auditoria das chamadas de LLM (modelo, tokens, request id, desfecho, custo).
 * Append-only. O dinheiro em si está no ledger, ligado por llmCallId.
 */
export interface LlmCallLog {
  record(entry: LlmCallRecord): Promise<void>;
  list(filter?: { campaignId?: string }): Promise<readonly LlmCallRecord[]>;
}

export class InMemoryLlmCallLog implements LlmCallLog {
  private readonly entries: LlmCallRecord[] = [];

  async record(entry: LlmCallRecord): Promise<void> {
    this.entries.push(Object.freeze(LlmCallRecordSchema.parse(entry)));
  }

  async list(filter: { campaignId?: string } = {}): Promise<readonly LlmCallRecord[]> {
    return this.entries.filter((e) => filter.campaignId === undefined || e.campaignId === filter.campaignId);
  }
}

/** <dataDir>/llm-calls.jsonl */
export class FileLlmCallLog implements LlmCallLog {
  private readonly file: JsonlFile<LlmCallRecord>;

  constructor(dataDir: string, onWarning?: (message: string) => void) {
    this.file = new JsonlFile(join(dataDir, "llm-calls.jsonl"), LlmCallRecordSchema, onWarning);
  }

  record(entry: LlmCallRecord): Promise<void> {
    return this.file.append(entry);
  }

  async list(filter: { campaignId?: string } = {}): Promise<readonly LlmCallRecord[]> {
    const all = await this.file.readAll();
    return all.filter((e) => filter.campaignId === undefined || e.campaignId === filter.campaignId);
  }
}
