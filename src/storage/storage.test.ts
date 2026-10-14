import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GenerationCost } from "@/domain/cost";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { campaignRequest } from "@/test/fixtures";
import { CorruptedDataError, writeFileAtomic } from "./atomic-file";
import { FileCostLedger } from "./file-cost-ledger";
import { FilePipelineStore } from "./file-pipeline-store";
import { JsonlFile } from "./jsonl-file";
import { FileLlmCallLog } from "./llm-call-log";
import { NotFoundError } from "./pipeline-store";
import { QUALITY_PRESETS } from "@/config/quality-presets";

let dir: string;
const quiet = () => undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tacf-storage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "campaign_1",
    status: "draft",
    request: campaignRequest(),
    settings: QUALITY_PRESETS.economy,
    jobIds: [],
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

function job(over: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job_1",
    campaignId: "campaign_1",
    creativeId: "creative_1",
    status: "planned",
    scenes: [],
    audioAttempts: [],
    renders: [],
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

function cost(id: string): GenerationCost {
  return {
    kind: "actual",
    id,
    campaignId: "campaign_1",
    jobId: null,
    creativeId: null,
    sceneId: null,
    attemptId: null,
    llmCallId: "llmcall_1",
    operation: "campaign_plan",
    category: "llm",
    description: "teste",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    unit: "per_1m_output_tokens",
    quantity: 1000,
    unitPriceUsd: 10,
    costUsd: 0.01,
    exchangeRate: 5,
    costBrl: 0.05,
    simulated: false,
    createdAt: "t",
  };
}

describe("writeFileAtomic", () => {
  it("substitui o conteúdo inteiro e não deixa temporários", async () => {
    const path = join(dir, "a", "f.json");
    await writeFileAtomic(path, "v1");
    await writeFileAtomic(path, "v2");
    expect(await readFile(path, "utf8")).toBe("v2");
    expect(await readdir(join(dir, "a"))).toEqual(["f.json"]);
  });
});

describe("FilePipelineStore", () => {
  it("persiste campanha e job e recupera em uma NOVA instância (restart)", async () => {
    const s1 = new FilePipelineStore(dir);
    await s1.saveCampaign(campaign({ jobIds: ["job_1"] }));
    await s1.saveJob(job({ status: "awaiting_approval" }));

    const s2 = new FilePipelineStore(dir);
    expect((await s2.getCampaign("campaign_1")).jobIds).toEqual(["job_1"]);
    expect((await s2.getJob("job_1")).status).toBe("awaiting_approval");
    expect((await s2.listJobs("campaign_1")).map((j) => j.id)).toEqual(["job_1"]);
  });

  it("NotFound para IDs ausentes e rejeita IDs que não são nomes de arquivo seguros", async () => {
    const s = new FilePipelineStore(dir);
    await expect(s.getJob("job_x")).rejects.toThrow(NotFoundError);
    await expect(s.getJob("../etc/passwd")).rejects.toThrow(/ID inválido/);
  });

  it("valida ao salvar e detecta arquivo corrompido ao ler", async () => {
    const s = new FilePipelineStore(dir);
    await expect(s.saveJob({ ...job(), status: "voando" } as unknown as GenerationJob)).rejects.toThrow();
    await s.saveJob(job());
    await writeFile(join(dir, "jobs", "job_1.json"), '{"id":');
    await expect(s.getJob("job_1")).rejects.toThrow(CorruptedDataError);
  });

  it("limpa temporários órfãos de escritas interrompidas", async () => {
    const s1 = new FilePipelineStore(dir);
    await s1.saveJob(job());
    await writeFile(join(dir, "jobs", "job_1.json.999.abc.tmp"), "lixo");
    const s2 = new FilePipelineStore(dir);
    await s2.saveJob(job({ id: "job_2" }));
    expect((await readdir(join(dir, "jobs"))).sort()).toEqual(["job_1.json", "job_2.json"]);
  });
});

describe("JsonlFile", () => {
  const Rec = z.object({ n: z.int() });

  it("append + readAll em ordem", async () => {
    const f = new JsonlFile(join(dir, "x.jsonl"), Rec, quiet);
    await Promise.all([f.append({ n: 1 }), f.append({ n: 2 }), f.append({ n: 3 })]);
    expect(await f.readAll()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("linha final interrompida é ignorada na leitura e removida antes do próximo append", async () => {
    const path = join(dir, "x.jsonl");
    await writeFile(path, '{"n":1}\n{"n":');
    const warnings: string[] = [];
    const f = new JsonlFile(path, Rec, (m) => warnings.push(m));
    expect(await f.readAll()).toEqual([{ n: 1 }]);
    await f.append({ n: 2 });
    expect(await readFile(path, "utf8")).toBe('{"n":1}\n{"n":2}\n');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("linha completa inválida é corrupção, nunca ignorada", async () => {
    const path = join(dir, "x.jsonl");
    await writeFile(path, '{"n":1}\n{"n":"dois"}\n');
    await expect(new JsonlFile(path, Rec, quiet).readAll()).rejects.toThrow(CorruptedDataError);
  });

  it("valida o registro antes de gravar", async () => {
    const f = new JsonlFile(join(dir, "x.jsonl"), Rec, quiet);
    await expect(f.append({ n: 1.5 })).rejects.toThrow();
  });
});

describe("FileCostLedger", () => {
  it("custos sobrevivem a restart e continuam append-only", async () => {
    const l1 = new FileCostLedger(dir, quiet);
    await l1.record(cost("cost_1"));
    await l1.record(cost("cost_2"));

    const l2 = new FileCostLedger(dir, quiet);
    expect((await l2.list({ campaignId: "campaign_1" })).map((e) => e.id)).toEqual(["cost_1", "cost_2"]);
    await expect(l2.record(cost("cost_1"))).rejects.toThrow(/duplicado/);
    await l2.record(cost("cost_3"));
    expect((await new FileCostLedger(dir, quiet).list()).length).toBe(3);
  });

  it("ID duplicado no arquivo é tratado como corrupção", async () => {
    const line = `${JSON.stringify(cost("cost_1"))}\n`;
    await appendFile(join(dir, "ledger.jsonl"), line + line);
    await expect(new FileCostLedger(dir, quiet).list()).rejects.toThrow(CorruptedDataError);
  });
});

describe("FileLlmCallLog", () => {
  it("persiste registros de chamadas de LLM", async () => {
    const log = new FileLlmCallLog(dir, quiet);
    await log.record({
      id: "llmcall_1",
      campaignId: "campaign_1",
      operation: "campaign_plan",
      promptId: "campaign-plan",
      promptVersion: "1.0.0",
      provider: "anthropic",
      requestedModel: "claude-sonnet-5-5",
      servedModel: "claude-sonnet-5-5",
      requestId: "req_1",
      attempt: 1,
      usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: "end_turn",
      outcome: "valid",
      durationMs: 10,
      costUsd: 0.1,
      costBrl: 0.5,
      exchangeRate: 5,
      simulated: false,
      createdAt: "t",
    });
    expect((await new FileLlmCallLog(dir, quiet).list({ campaignId: "campaign_1" }))[0]?.requestId).toBe("req_1");
  });
});
