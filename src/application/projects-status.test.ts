import { describe, expect, it } from "vitest";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { matchesFilter, projectCard, projectStatus, queryProjects, type ProjectCard, type ProjectFlags } from "./project-v2-view";

/** L8.6 — status honesto do projeto (sem "Rascunho") + busca/filtro/ordenação da biblioteca. */

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1", status: "planned", createdAt: "2026-10-20T12:00:00Z", planningRuns: 1, planningStartedAt: "2026-10-20T12:00:00Z",
  request: { projectName: "Secador", product: { id: "prod_1", name: "Secador Taiff", images: [{ id: "img_0f8fad5b-d9cb-469f-a165-70867728950e.png", uri: "x" }] }, targetDurationSeconds: 30, creativeMode: "ai_ugc", avatar: { snapshot: { name: "Cristina" } } },
  ...over,
}) as unknown as Campaign;
const job = (over: Partial<GenerationJob> = {}): GenerationJob => ({ id: "job_1", creativeId: "k1", status: "awaiting_approval", renders: [], scenes: [], ...over }) as unknown as GenerationJob;
const flags = (over: Partial<ProjectFlags> = {}): ProjectFlags => ({ planningActive: false, jobActive: false, ...over });

describe("status honesto", () => {
  it("aguardando aprovação NUNCA vira \"Rascunho\": roteiro não iniciado e geração não autorizada", () => {
    expect(projectStatus(campaign({ status: "draft", planningRuns: undefined, planningStartedAt: undefined }), undefined, flags())).toBe("awaiting_approval");
    for (const status of ["planned", "cost_estimated", "awaiting_approval", "budget_exceeded"] as const) expect(projectStatus(campaign(), job({ status }), flags())).toBe("awaiting_approval");
    expect(JSON.stringify(projectCard(campaign(), job(), flags()))).not.toContain("Rascunho");
  });

  it("fila × gerando vem do dado da fila (planejamento e geração)", () => {
    expect(projectStatus(campaign({ status: "planning" }), undefined, flags({ planningActive: true, planningQueued: true }))).toBe("queued");
    expect(projectStatus(campaign({ status: "planning" }), undefined, flags({ planningActive: true }))).toBe("preparing");
    expect(projectStatus(campaign(), job({ status: "generating" }), flags({ jobActive: true, jobQueued: true }))).toBe("queued");
    expect(projectStatus(campaign(), job({ status: "generating" }), flags({ jobActive: true }))).toBe("generating");
  });

  it("pronto, simulação, falhou, pausado por segurança e atenção", () => {
    expect(projectStatus(campaign(), job({ status: "completed", renders: [{ status: "completed", isMock: false }] as never }), flags())).toBe("ready");
    expect(projectStatus(campaign(), job({ status: "completed", renders: [{ status: "completed", isMock: true }] as never }), flags())).toBe("simulated");
    expect(projectStatus(campaign(), job({ status: "failed" }), flags())).toBe("failed");
    expect(projectStatus(campaign(), job({ status: "generating" }), flags())).toBe("failed"); // interrompido sem operação paga em voo
    expect(projectStatus(campaign(), job({ status: "generating", ugcVideoOperations: [{ state: "pending" }] as never }), flags())).toBe("blocked");
    expect(projectStatus(campaign(), job({ status: "generating", waitingForStage: "ugc_reference" }), flags())).toBe("attention");
    expect(projectStatus(campaign({ status: "failed" }), undefined, flags())).toBe("failed");
  });

  it("worker offline não muda o status (o job ativo continua na fila)", () => {
    expect(projectStatus(campaign(), job({ status: "generating" }), flags({ jobActive: true, jobQueued: true }))).toBe("queued");
  });

  it("card: créditos reais só com ledger real; estimativa só em produção", () => {
    const auth = { jobAuthorization: { estimatedBrl: 20, baselineActualBrl: 0.5, status: "active" } } as unknown as Partial<GenerationJob>;
    expect(projectCard(campaign(), job({ status: "generating", ...auth }), flags({ jobActive: true }), 3.2)).toMatchObject({ actualBrl: 3.2, estimatedBrl: 20.5 });
    expect(projectCard(campaign(), job({ status: "failed", ...auth }), flags(), 0)).toMatchObject({ actualBrl: null, estimatedBrl: null });
  });

  it("thumbnail: referência real > produto > nenhuma", () => {
    const withRef = job({ ugc: { references: [{ state: "succeeded", isMock: false, review: "approved", version: "v2" }] } as never });
    expect(projectCard(campaign(), withRef, flags())).toMatchObject({ thumbnailKind: "reference", thumbnailUrl: expect.stringContaining("/api/ugc/c1/k1/v2") });
    expect(projectCard(campaign(), job(), flags())).toMatchObject({ thumbnailKind: "product", thumbnailUrl: expect.stringContaining("/api/uploads/prod_1/") });
    expect(projectCard(campaign({ request: { ...campaign().request, product: { id: "p", name: "X", images: [] } } as never }), job(), flags())).toMatchObject({ thumbnailKind: null, thumbnailUrl: null });
  });
});

const card = (id: string, over: Partial<ProjectCard>): ProjectCard => ({
  id, name: id, productName: id, thumbnailUrl: null, thumbnailKind: null, avatarName: null, durationLabel: "30s", status: "ready", statusLabel: "Pronto",
  createdAt: "2026-10-01T00:00:00Z", dateLabel: "x", actualBrl: null, estimatedBrl: null, ...over,
});
const CARDS = [
  card("Secador Taiff", { productName: "Secador 2100W", avatarName: "Cristina", status: "ready", createdAt: "2026-10-03T00:00:00Z", actualBrl: 19.87 }),
  card("Fone Pro", { status: "generating", createdAt: "2026-10-05T00:00:00Z", actualBrl: 2 }),
  card("Sérum", { status: "awaiting_approval", createdAt: "2026-10-01T00:00:00Z" }),
  card("Garrafa", { status: "blocked", createdAt: "2026-10-04T00:00:00Z", actualBrl: 30 }),
  card("Mochila", { status: "queued", createdAt: "2026-10-02T00:00:00Z" }),
];

describe("biblioteca: busca, filtros e ordenação no cliente", () => {
  it("busca por nome, produto e avatar (sem acento, sem caixa)", () => {
    expect(queryProjects(CARDS, { search: "serum" }).map((c) => c.id)).toEqual(["Sérum"]);
    expect(queryProjects(CARDS, { search: "2100w" }).map((c) => c.id)).toEqual(["Secador Taiff"]);
    expect(queryProjects(CARDS, { search: "cristina" }).map((c) => c.id)).toEqual(["Secador Taiff"]);
    expect(queryProjects(CARDS, { search: "nada" })).toEqual([]);
  });

  it("filtros com estados reais", () => {
    expect(queryProjects(CARDS, { filter: "in_production" }).map((c) => c.id)).toEqual(["Fone Pro", "Mochila"]);
    expect(queryProjects(CARDS, { filter: "awaiting_approval" }).map((c) => c.id)).toEqual(["Sérum"]);
    expect(queryProjects(CARDS, { filter: "ready" }).map((c) => c.id)).toEqual(["Secador Taiff"]);
    expect(queryProjects(CARDS, { filter: "attention" }).map((c) => c.id)).toEqual(["Garrafa"]);
    expect(matchesFilter(card("x", { status: "failed" }), "attention")).toBe(true);
    // Compatível com o filtro antigo da API.
    expect(matchesFilter(card("x", { status: "queued" }), "in_progress")).toBe(true);
  });

  it("ordenação: mais recentes, mais antigos e maior consumo (custo real)", () => {
    expect(queryProjects(CARDS, {}).map((c) => c.id)).toEqual(["Fone Pro", "Garrafa", "Secador Taiff", "Mochila", "Sérum"]);
    expect(queryProjects(CARDS, { sort: "oldest" }).map((c) => c.id)).toEqual(["Sérum", "Mochila", "Secador Taiff", "Garrafa", "Fone Pro"]);
    expect(queryProjects(CARDS, { sort: "cost" }).map((c) => c.id).slice(0, 3)).toEqual(["Garrafa", "Secador Taiff", "Fone Pro"]);
  });
});
