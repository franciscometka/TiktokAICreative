import { describe, expect, it } from "vitest";
import { InMemoryAvatarLibraryStore } from "@/storage/avatar-store";
import { PNG_BYTES, tempUploads } from "@/test/app-fixtures";
import { ugcHarness } from "@/test/ugc-harness";
import { getCampaignView } from "./campaign-actions";
import {
  autoAvatarPreview, createFlowReducer, creditsReview, firstInvalidStep, initialCreateState, QUALITY_OPTIONS, toCreateInput,
  type AvatarChoice, type CreateFlowState,
} from "./create-flow";
import { CreateV2InputSchema, startVideoV2, type V2EstimateView } from "./create-v2";
import { buildProjectV2View } from "./project-v2-view";

const IMG = "img_0f8fad5b-d9cb-469f-a165-70867728950e.png";

/** L8.4 — rascunho único do Create (reducer), revalidação da URL, créditos e criação real. */

const base = (search: Record<string, string> = {}, avatarIds: string[] = ["avatar_cris"]) => initialCreateState({ newProductId: "prod_new", search, avatarIds });
const ready = (): CreateFlowState => {
  const s = base({ product: "prod_home", image: IMG, idea: "Natural no quarto", preset: "demo" });
  return createFlowReducer(s, { type: "set", patch: { name: "Secador" } });
};
const estimate = (duration: 30 | 45 | 60, quality: "economy" | "high" | "premium", totalBrl: number, provisional = false): V2EstimateView => ({ duration, quality, clips: 4, totalBrl, lines: [{ label: "Vídeo", brl: totalBrl }], provisional });
const ESTIMATES = [estimate(30, "economy", 11.72), estimate(30, "high", 22.72), estimate(30, "premium", 40), estimate(45, "economy", 16), estimate(45, "high", 33), estimate(45, "premium", 60), estimate(60, "economy", 20.52), estimate(60, "high", 40.32), estimate(60, "premium", 80)];
const cristina: AvatarChoice = { id: "avatar_cris", name: "Cristina", imageUrl: "/api/uploads/a/img_1.png", tags: ["beleza"], defaultForTags: ["cabelo"], preferredProductCategories: [], voiceName: "Clara BR", revision: 1, updatedAt: "2026-10-01T00:00:00Z" };

describe("Home → Create: rascunho revalidado da URL", () => {
  it("foto, ideia e preset vindos da Home viram o rascunho", () => {
    const { draft, step } = base({ product: "prod_home", image: IMG, idea: "  Mulher no quarto  ", preset: "demo" });
    expect(step).toBe("product");
    expect(draft).toMatchObject({ productId: "prod_home", images: [{ id: IMG, previewUrl: `/api/uploads/prod_home/${IMG}` }], idea: "Mulher no quarto", preset: "demo", duration: 60 });
    expect(draft.tone).toMatch(/Didático/);
  });

  it("URL inválida → padrões seguros (foto, preset, avatar, duração e qualidade)", () => {
    const { draft } = base({ product: "../../etc", image: "evil.exe", preset: "hack", avatar: "nope", duration: "99", quality: "ultra" });
    expect(draft).toMatchObject({ productId: "prod_new", images: [], preset: "natural", avatar: "auto", duration: 30, quality: "high" });
    expect(base({ product: "prod_ok", image: "../x.png" }).draft.images).toEqual([]);
    expect(base({ avatar: "avatar_cris", duration: "45", quality: "premium" }).draft).toMatchObject({ avatar: "avatar_cris", duration: 45, quality: "premium" });
    expect(base({ idea: "x".repeat(3000) }).draft.idea).toHaveLength(2000);
  });
});

describe("reducer: etapas, validação, next/back", () => {
  it("não avança sem foto, nome e ideia; mensagens por campo", () => {
    const s = createFlowReducer(base(), { type: "next" });
    expect(s.step).toBe("product");
    expect(s.errors).toEqual({ images: "Envie uma foto do produto.", name: "Informe o nome do produto.", idea: "Conte em poucas palavras o que você quer criar." });
    expect(createFlowReducer(s, { type: "set", patch: { name: "X" } }).errors.name).toBeUndefined();
  });

  it("next → avatar → estilo → revisão; back volta; rascunho preservado", () => {
    let s = ready();
    for (const expected of ["avatar", "style", "review"] as const) { s = createFlowReducer(s, { type: "next" }); expect(s.step).toBe(expected); }
    s = createFlowReducer(s, { type: "back" });
    expect(s.step).toBe("style");
    expect(s.draft).toMatchObject({ name: "Secador", idea: "Natural no quarto", images: [{ id: IMG }] });
  });

  it("goto para frente só com os passos anteriores válidos", () => {
    const s = createFlowReducer(base(), { type: "goto", step: "review" });
    expect(s.step).toBe("product");
    expect(Object.keys(s.errors)).toContain("name");
    expect(createFlowReducer(ready(), { type: "goto", step: "review" }).step).toBe("review");
    expect(firstInvalidStep(base().draft)).toBe("product");
    expect(firstInvalidStep(ready().draft)).toBeNull();
  });

  it("preset só preenche tom, CTA e duração; qualidade e avatar ficam", () => {
    const s = createFlowReducer(createFlowReducer(ready(), { type: "set", patch: { quality: "premium", avatar: "avatar_cris" } }), { type: "preset", id: "offer" });
    expect(s.draft).toMatchObject({ preset: "offer", duration: 30, quality: "premium", avatar: "avatar_cris" });
    expect(s.draft.cta).toMatch(/oferta/i);
  });

  it("erros do servidor levam ao passo do campo", () => {
    const s = createFlowReducer({ ...ready(), step: "review" }, { type: "serverErrors", errors: { imageIds: "Uma das fotos não foi encontrada. Envie de novo." } });
    expect(s.step).toBe("product");
    expect(s.errors.images).toMatch(/não foi encontrada/);
  });
});

describe("rascunho → mesmo input do Create antigo", () => {
  it("toCreateInput passa no schema do startVideoV2; personalizar só manda o que mudou", () => {
    const draft = { ...ready().draft, environment: "bedroom" as const, gender: "woman" as const, voiceLock: "native" as const };
    const input = toCreateInput(draft);
    expect(CreateV2InputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ productId: "prod_home", imageIds: [IMG], avatar: "auto", duration: 60, style: "ugc_natural", personalize: { gender: "woman", environment: "bedroom" }, advanced: { quality: "high", voiceLock: "native" } });
    // Avatar escolhido: gênero vem do avatar (o campo não vai).
    expect(toCreateInput({ ...draft, avatar: "avatar_cris" }).personalize).not.toHaveProperty("gender");
  });

  it("qualidade: Econômico, Equilibrado, Premium (nunca \"Balanceado\")", () => {
    expect(QUALITY_OPTIONS.map((q) => [q.value, q.label])).toEqual([["economy", "Econômico"], ["high", "Equilibrado"], ["premium", "Premium"]]);
    expect(JSON.stringify(QUALITY_OPTIONS)).not.toContain("Balanceado");
  });

  it("escolha automática usa a mesma seleção por tags do servidor", () => {
    expect(autoAvatarPreview([cristina], { name: "Secador de cabelo", idea: "no quarto" })).toMatchObject({ avatar: { id: "avatar_cris" }, detail: "padrão para cabelo" });
    expect(autoAvatarPreview([cristina], { name: "Furadeira", idea: "na oficina" }).avatar).toBeNull();
  });
});

describe("créditos na revisão (L8.2)", () => {
  it("estimativa ~N, saldo atual e saldo estimado após", () => {
    expect(creditsReview({ estimates: ESTIMATES, duration: 30, quality: "high", credits: { perBrl: 100, remaining: 10_000 } })).toEqual({ estimated: 2272, provisional: false, remaining: 10_000, after: 7728, insufficient: false, cheaper: null });
  });

  it("saldo insuficiente: necessário × disponível e configuração mais barata que cabe", () => {
    const r = creditsReview({ estimates: ESTIMATES, duration: 60, quality: "high", credits: { perBrl: 100, remaining: 2100 } })!;
    expect(r).toMatchObject({ insufficient: true, estimated: 4032, remaining: 2100, cheaper: { duration: 60, quality: "economy", estimated: 2052 } });
    // Nada cabe → nenhuma sugestão inventada.
    expect(creditsReview({ estimates: ESTIMATES, duration: 30, quality: "economy", credits: { perBrl: 100, remaining: 50 } })!.cheaper).toBeNull();
  });

  it("mesmo preço entre Econômico e Equilibrado não é \"corrigido\"", () => {
    const same = [estimate(30, "economy", 22.72), estimate(30, "high", 22.72)];
    const r = creditsReview({ estimates: same, duration: 30, quality: "high", credits: { perBrl: 100, remaining: 2000 } })!;
    expect(r.cheaper).toBeNull();
  });

  it("créditos não configurados → null (a tela mostra \"Créditos indisponíveis\")", () => {
    expect(creditsReview({ estimates: ESTIMATES, duration: 30, quality: "high", credits: null })).toBeNull();
  });
});

describe("criar projeto ≠ autorizar gasto", () => {
  it("o rascunho do Create cria o projeto pelo MESMO startVideoV2 e ele abre esperando a aprovação explícita", async () => {
    // Modo real sem mocks: nada é aprovado aqui, portanto nenhuma chamada paga.
    const h = await ugcHarness();
    const service = h.build({ allowMocks: false });
    const { uploads } = await tempUploads();
    const deps = { service, uploads, avatars: new InMemoryAvatarLibraryStore(), rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, defaultBudget: { maxCostPerCreativeBrl: 200, maxCostPerCampaignBrl: 500, allowOverBudget: false } };
    const photo = await uploads.save("prod_flow", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    let s = initialCreateState({ newProductId: "unused", search: { product: "prod_flow", image: photo.id, idea: "Natural no quarto", preset: "natural" }, avatarIds: [] });
    s = createFlowReducer(s, { type: "set", patch: { name: "Secador" } });
    const started = await startVideoV2(deps, toCreateInput(s.draft));
    if (!started.ok) throw new Error(started.error.message);
    const view = await getCampaignView(deps, started.value.campaignId);
    if (!view.ok) throw new Error(view.error.message);
    const v2 = buildProjectV2View(view.value);
    expect(v2.phase).toBe("planning_approval");
    expect(v2.headline).toBe("Tudo pronto para começar.");
    expect(v2.quoteToken).toBeTruthy();
    expect(view.value.costs.actual.totalBrl).toBe(0);
  });
});
