import type { ProjectFacts } from "@/application/project-facts";
import { CampaignSchema, GenerationJobSchema, type Campaign, type GenerationJob } from "@/domain/pipeline";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/**
 * Persistência de campanhas e jobs. Implementações: FilePipelineStore (padrão) e memória (testes).
 */
export interface PipelineStore {
  saveCampaign(campaign: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign>;
  saveJob(job: GenerationJob): Promise<void>;
  getJob(id: string): Promise<GenerationJob>;
  listJobs(campaignId: string): Promise<GenerationJob[]>;
  /** IDs de todas as campanhas (ordem não garantida). */
  listCampaignIds(): Promise<string[]>;
  /**
   * L8.8.1 (opcional, só leitura): fatos mínimos de TODOS os projetos numa consulta, sem trazer
   * documentos. Ausente = o chamador extrai dos documentos (modo local).
   */
  listProjectFacts?(): Promise<ProjectFacts[]>;
}

/** Guarda cópias validadas; leituras devolvem cópias (sem aliasing de objetos mutáveis). */
export class InMemoryPipelineStore implements PipelineStore {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly jobs = new Map<string, GenerationJob>();

  async saveCampaign(campaign: Campaign): Promise<void> {
    this.campaigns.set(campaign.id, CampaignSchema.parse(structuredClone(campaign)));
  }

  async getCampaign(id: string): Promise<Campaign> {
    const found = this.campaigns.get(id);
    if (!found) throw new NotFoundError(`Campanha não encontrada: ${id}`);
    return structuredClone(found);
  }

  async saveJob(job: GenerationJob): Promise<void> {
    this.jobs.set(job.id, GenerationJobSchema.parse(structuredClone(job)));
  }

  async getJob(id: string): Promise<GenerationJob> {
    const found = this.jobs.get(id);
    if (!found) throw new NotFoundError(`Job não encontrado: ${id}`);
    return structuredClone(found);
  }

  async listJobs(campaignId: string): Promise<GenerationJob[]> {
    return [...this.jobs.values()].filter((j) => j.campaignId === campaignId).map((j) => structuredClone(j));
  }

  async listCampaignIds(): Promise<string[]> {
    return [...this.campaigns.keys()];
  }
}
