import { join } from "node:path";
import { CampaignSchema, GenerationJobSchema, type Campaign, type GenerationJob } from "@/domain/pipeline";
import { cleanupTempFiles, CorruptedDataError, readTextIfExists, writeFileAtomic } from "./atomic-file";
import { NotFoundError, type PipelineStore } from "./pipeline-store";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`ID inválido para nome de arquivo: ${JSON.stringify(id)}`);
}

/**
 * Persistência local em arquivos JSON (um arquivo por campanha e por job).
 * Estimativas, aprovações, decisões de orçamento e tentativas ficam DENTRO do job.
 *
 *   <dataDir>/campaigns/<id>.json
 *   <dataDir>/jobs/<id>.json
 *
 * Toda escrita é atômica (writeFileAtomic). Tudo é validado com Zod ao salvar e ao ler.
 */
export class FilePipelineStore implements PipelineStore {
  private readonly campaignsDir: string;
  private readonly jobsDir: string;
  private initialized = false;

  constructor(dataDir: string) {
    this.campaignsDir = join(dataDir, "campaigns");
    this.jobsDir = join(dataDir, "jobs");
  }

  async saveCampaign(campaign: Campaign): Promise<void> {
    assertSafeId(campaign.id);
    await this.init();
    await writeFileAtomic(this.campaignPath(campaign.id), JSON.stringify(CampaignSchema.parse(campaign), null, 2));
  }

  async getCampaign(id: string): Promise<Campaign> {
    assertSafeId(id);
    return this.read(this.campaignPath(id), CampaignSchema.parse, `Campanha não encontrada: ${id}`);
  }

  async saveJob(job: GenerationJob): Promise<void> {
    assertSafeId(job.id);
    await this.init();
    await writeFileAtomic(this.jobPath(job.id), JSON.stringify(GenerationJobSchema.parse(job), null, 2));
  }

  async getJob(id: string): Promise<GenerationJob> {
    assertSafeId(id);
    return this.read(this.jobPath(id), GenerationJobSchema.parse, `Job não encontrado: ${id}`);
  }

  /** Jobs listados a partir de campaign.jobIds (fonte de verdade da composição da campanha). */
  async listJobs(campaignId: string): Promise<GenerationJob[]> {
    const campaign = await this.getCampaign(campaignId);
    return Promise.all(campaign.jobIds.map((id) => this.getJob(id)));
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all([cleanupTempFiles(this.campaignsDir), cleanupTempFiles(this.jobsDir)]);
    this.initialized = true;
  }

  private async read<T>(path: string, parse: (data: unknown) => T, notFound: string): Promise<T> {
    const text = await readTextIfExists(path);
    if (text === undefined) throw new NotFoundError(notFound);
    try {
      return parse(JSON.parse(text));
    } catch (error) {
      throw new CorruptedDataError(`${path}: ${error instanceof Error ? error.message.slice(0, 300) : "inválido"}`);
    }
  }

  private campaignPath(id: string): string {
    return join(this.campaignsDir, `${id}.json`);
  }

  private jobPath(id: string): string {
    return join(this.jobsDir, `${id}.json`);
  }
}
