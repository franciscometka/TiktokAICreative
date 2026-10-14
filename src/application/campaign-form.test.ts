import { describe, expect, it } from "vitest";
import { CREATIVE_STYLES } from "@/domain/creative";
import { CampaignRequestSchema } from "@/domain/pipeline";
import { formInput } from "@/test/app-fixtures";
import { formInputFromRequest, parseBrlAmount, parseCampaignForm, toCampaignRequest } from "./campaign-form";

function errorsOf(input: unknown) {
  const result = parseCampaignForm(input);
  if (result.ok) throw new Error("esperava erro de validação");
  return result.error;
}

function valueOf(input: unknown) {
  const result = parseCampaignForm(input);
  if (!result.ok) throw new Error(`esperava sucesso: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("parseBrlAmount", () => {
  it.each([
    ["79,90", 79.9],
    ["79.90", 79.9],
    ["R$ 1.299,90", 1299.9],
    ["20", 20],
  ])("%s → %d", (raw, expected) => expect(parseBrlAmount(raw)).toBe(expected));

  it("vazio = undefined; texto inválido = NaN", () => {
    expect(parseBrlAmount("  ")).toBeUndefined();
    expect(parseBrlAmount("abc")).toBeNaN();
    expect(parseBrlAmount("1,2,3")).toBeNaN();
  });
});

describe("validação do formulário", () => {
  it("aceita o mínimo e normaliza listas, preço e opcionais vazios", () => {
    const form = valueOf(formInput());
    expect(form.features).toEqual(["Aço inox", "750ml"]);
    expect(form.priceBrl).toBe(89.9);
    expect(form.url).toBeUndefined();
    expect(form.audience).toBeUndefined();
    expect(form.budget).toEqual({ maxCostPerCreativeBrl: 15, maxCostPerCampaignBrl: 100, allowOverBudget: true });
  });

  it("nome e descrição são obrigatórios, com mensagem por campo", () => {
    const errors = errorsOf(formInput({ name: "  ", description: "" }));
    expect(errors.name).toBe("Informe o nome do produto.");
    expect(errors.description).toBe("Descreva o produto.");
  });

  it("link precisa ser http(s); preço precisa ser positivo", () => {
    const errors = errorsOf(formInput({ url: "javascript:alert(1)", price: "-3" }));
    expect(errors.url).toMatch(/https:\/\//);
    expect(errors.price).toMatch(/positivo/);
    expect(valueOf(formInput({ url: "https://loja.com/p/1" })).url).toBe("https://loja.com/p/1");
  });

  it("limita tamanho de listas e de itens", () => {
    const errors = errorsOf(formInput({ features: Array.from({ length: 16 }, (_, i) => `item ${i}`) }));
    expect(errors.features).toMatch(/No máximo 15/);
  });

  it("imagens só por ID gerado pelo sistema (nunca caminhos)", () => {
    const errors = errorsOf(formInput({ imageIds: ["../../etc/passwd"] }));
    expect(errors["imageIds.0"]).toBe("Imagem inválida.");
    expect(errorsOf(formInput({ productId: "../x" })).productId).toBeDefined();
  });

  it("quantidade de criativos só nas opções oferecidas", () => {
    expect(errorsOf(formInput({ creativeCount: 4 })).creativeCount).toMatch(/1, 2, 3, 5/);
    expect(valueOf(formInput({ creativeCount: 5 })).creativeCount).toBe(5);
  });

  it("orçamento: obrigatório, positivo e limite por criativo ≤ campanha", () => {
    expect(errorsOf(formInput({ budget: { maxCostPerCreativeBrl: "", maxCostPerCampaignBrl: "100", allowOverBudget: false } }))[
      "budget.maxCostPerCreativeBrl"
    ]).toMatch(/Informe/);
    expect(errorsOf(formInput({ budget: { maxCostPerCreativeBrl: "50", maxCostPerCampaignBrl: "20", allowOverBudget: false } }))[
      "budget.maxCostPerCreativeBrl"
    ]).toMatch(/não pode ser maior/);
  });
});

describe("estratégia e qualidade", () => {
  it("AUTO envia todos os formatos e marca a seleção como auto", () => {
    const form = valueOf(formInput({ styleMode: "auto", styles: [] }));
    expect(form.styles).toEqual([...CREATIVE_STYLES]);
    expect(form.styleSelection).toBe("auto");
  });

  it("manual exige ao menos um formato válido", () => {
    expect(errorsOf(formInput({ styleMode: "manual", styles: [] })).styles).toMatch(/AUTO/);
    expect(errorsOf(formInput({ styleMode: "manual", styles: ["ugc", "dance"] })).styles).toBeDefined();
    expect(valueOf(formInput({ styles: ["review", "review"] })).styles).toEqual(["review"]);
  });

  it("qualidade só entre os presets (custom não é oferecido na UI)", () => {
    expect(errorsOf(formInput({ quality: "custom" })).quality).toBe("Escolha um nível de qualidade.");
    expect(errorsOf(formInput({ quality: "ultra" })).quality).toBeDefined();
    for (const q of ["economy", "high", "premium"]) expect(valueOf(formInput({ quality: q })).quality).toBe(q);
  });
});

describe("toCampaignRequest / formInputFromRequest", () => {
  it("monta um CampaignRequest válido do domínio com as imagens do store", () => {
    const form = valueOf(formInput());
    const request = toCampaignRequest(form, [{ id: "img_1", uri: "outputs/uploads/prod_test/img_1.png" }]);
    expect(CampaignRequestSchema.parse(request)).toMatchObject({
      product: { id: "prod_test", name: "Garrafa Térmica X", priceBrl: 89.9 },
      styleSelection: "manual",
      quality: "economy",
    });
    expect(request.product.images).toHaveLength(1);
  });

  it("ida e volta preserva o formulário (planejar de novo com ajustes)", () => {
    const form = valueOf(formInput({ styleMode: "auto", styles: [] }));
    const back = formInputFromRequest(toCampaignRequest(form, []));
    expect(valueOf(back)).toEqual(form);
  });
});
