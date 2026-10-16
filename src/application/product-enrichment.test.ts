import { describe, expect, it } from "vitest";
import { enrichProductLocally } from "./product-enrichment";

describe("enriquecimento local do produto", () => {
  it("estrutura apenas fatos fornecidos e não inventa benefícios", () => {
    const result = enrichProductLocally({ name: "Copo térmico", description: "Aço inox. Tampa rosqueável." });
    expect(result.features).toEqual(["Aço inox", "Tampa rosqueável"]);
    expect(result.benefits).toEqual([]);
    expect(result.description).toBe("Aço inox. Tampa rosqueável.");
  });

  it("deixa explícita a ausência de detalhes", () => {
    const result = enrichProductLocally({ name: "Organizador", description: "" });
    expect(result.description).toContain("adicione detalhes confirmados");
  });
});
