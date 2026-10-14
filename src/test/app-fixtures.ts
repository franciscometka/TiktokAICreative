import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockCreativePlanner } from "@/ai/mock-planner";
import type { CreativePlanner, PlanningRequest, PlanningResult } from "@/ai/planner";
import type { CampaignFormInput } from "@/application/campaign-form";
import type { IdGenerator } from "@/lib/ids";
import { LocalUploadStore } from "@/storage/upload-store";

/** Fixtures da camada de aplicação (formulário, uploads, planner controlável). */

export function formInput(over: Partial<CampaignFormInput> = {}): CampaignFormInput {
  return {
    productId: "prod_test",
    name: "Garrafa Térmica X",
    url: "",
    description: "Garrafa térmica de aço inox que mantém a bebida gelada por 24h.",
    features: ["Aço inox", "  ", "750ml"],
    benefits: ["Bebida gelada o dia todo"],
    price: "89,90",
    audience: "",
    notes: "",
    imageIds: [],
    creativeCount: 1,
    styleMode: "manual",
    styles: ["ugc", "problem_solution"],
    quality: "economy",
    budget: { maxCostPerCreativeBrl: "15,00", maxCostPerCampaignBrl: "100", allowOverBudget: true },
    ...over,
  };
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);

export async function tempUploads(): Promise<{ dir: string; uploads: LocalUploadStore }> {
  const dir = await mkdtemp(join(tmpdir(), "cf-uploads-"));
  return { dir, uploads: new LocalUploadStore(dir) };
}

/**
 * Planner mock que só termina quando o teste libera (simula uma chamada longa ao Claude).
 * `calls` conta quantas vezes o planejamento foi de fato executado.
 */
export class GatedPlanner implements CreativePlanner {
  readonly id = "mock";
  calls = 0;
  private readonly inner: MockCreativePlanner;
  private gates: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  /** Liberações/falhas pedidas antes de o plan() chegar à trava (evita corrida no teste). */
  private early: ({ ok: true } | { ok: false; error: unknown })[] = [];

  constructor(ids: IdGenerator) {
    this.inner = new MockCreativePlanner(ids);
  }

  worstCase(request: PlanningRequest) {
    return this.inner.worstCase(request);
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    this.calls++;
    const early = this.early.shift();
    if (early) {
      if (!early.ok) throw early.error;
    } else {
      await new Promise<void>((resolve, reject) => this.gates.push({ resolve, reject }));
    }
    return this.inner.plan(request);
  }

  release(): void {
    const gate = this.gates.shift();
    if (gate) gate.resolve();
    else this.early.push({ ok: true });
  }

  fail(error: unknown): void {
    const gate = this.gates.shift();
    if (gate) gate.reject(error);
    else this.early.push({ ok: false, error });
  }
}

/** Espera microtarefas/IO pendentes (o planejamento roda "em background"). */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/** Repete a checagem até ser verdadeira (I/O real em disco não cabe em poucas microtarefas). */
export async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 10));
  }
}
