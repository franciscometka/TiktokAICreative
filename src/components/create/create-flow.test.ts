import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFlowReducer, initialCreateState, type AvatarChoice, type CreateFlowState } from "@/application/create-flow";
import type { V2EstimateView } from "@/application/create-v2";
import { isDarkRoute } from "../shell/nav";
import { ServiceUnavailable } from "../v2/service-unavailable";
import { AvatarStep, CreateFlow, CreditsBox, PersonalizeSheet, ReviewStep } from "./create-flow";

const IMG = "img_0f8fad5b-d9cb-469f-a165-70867728950e.png";

/** L8.4 — UI do Create em 4 passos: etapas, upload, catálogo de avatar, estilo, revisão e créditos. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const estimates: V2EstimateView[] = [30, 45, 60].flatMap((duration) => (["economy", "high", "premium"] as const).map((quality, i) => ({ duration: duration as 30, quality, clips: 4, totalBrl: (duration / 30) * [11.72, 22.72, 40][i]!, lines: [], provisional: false })));
const avatars: AvatarChoice[] = [
  { id: "avatar_cris", name: "Cristina Souza", imageUrl: "/api/uploads/a/img_1.png", tags: ["beleza", "cabelo"], defaultForTags: ["cabelo"], preferredProductCategories: [], voiceName: "Clara BR", revision: 1, updatedAt: "2026-10-01T00:00:00Z" },
  { id: "avatar_raf", name: "Rafael", imageUrl: null, tags: [], defaultForTags: [], preferredProductCategories: [], voiceName: null, revision: 1, updatedAt: "2026-10-01T00:00:00Z" },
];
const Uploader = () => createElement("div", { "data-uploader": "shared" }, "UPLOADER");
const atStep = (step: CreateFlowState["step"], search: Record<string, string> = {}): CreateFlowState => {
  const s = initialCreateState({ newProductId: "prod_1", search: { product: "prod_1", image: IMG, idea: "Natural no quarto", ...search }, avatarIds: avatars.map((a) => a.id) });
  return { ...createFlowReducer(s, { type: "set", patch: { name: "Secador" } }), step };
};
const flow = (initial: CreateFlowState, credits: { perBrl: number; remaining: number } | null = { perBrl: 100, remaining: 10_000 }, planningAvailable = true) =>
  renderToStaticMarkup(createElement(CreateFlow, { initial, avatars, estimates, credits, planningAvailable, Uploader, submit: async () => ({ ok: true as const, value: { campaignId: "c" } }), onCreated: () => undefined }));

describe("etapas", () => {
  it("01 Produto · 02 Avatar · 03 Estilo · 04 Revisão; passo atual marcado", () => {
    const html = flow(atStep("product"));
    for (const s of ["01", "Produto", "02", "Avatar", "03", "Estilo", "04", "Revisão"]) expect(text(html)).toContain(s);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-create-step="product"');
  });

  it("Produto: upload compartilhado + nome + ideia; link para o modo avançado", () => {
    const html = flow(atStep("product"));
    expect(html).toContain('data-uploader="shared"');
    expect(text(html)).toContain("Nome do produto");
    expect(text(html)).toContain("O que você quer criar?");
    expect(html).toContain('href="/create?mode=advanced"');
    expect(text(html)).toContain("Continuar");
  });

  it("Create é dark nativo; ?mode=advanced continua na ilha clara (data-surface=legacy na página)", () => {
    expect(isDarkRoute("/create")).toBe(true);
  });
});

describe("avatar", () => {
  it("catálogo visual: foto ou iniciais, voz, tags e \"Padrão para\"; escolha automática funcional", () => {
    const html = renderToStaticMarkup(createElement(AvatarStep, { draft: { ...atStep("avatar").draft, name: "Secador de cabelo" }, avatars, set: () => undefined }));
    const t = text(html);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio" aria-checked="true" aria-label="Escolha automática"/);
    expect(t).toContain("Provável: Cristina Souza · padrão para cabelo");
    expect(html).toContain('src="/api/uploads/a/img_1.png"');
    // Sem foto: iniciais (Rafael → R); com foto: a própria foto, sem iniciais.
    expect(html).toMatch(/aria-hidden="true"[^>]*>R<\/span>/);
    expect(t).not.toContain(" CS ");
    expect(t).toContain("Voz: Clara BR");
    expect(t).toContain("Padrão para cabelo");
    expect(t).toContain("Sem foto: a aparência vem da descrição.");
    expect(html).toContain('href="/avatars/new"');
    expect(html).not.toContain("<select");
  });
});

describe("estilo e personalizar", () => {
  it("4 presets, duração 30/45/60, qualidade Econômico/Equilibrado/Premium e estimativa ~N", () => {
    const t = text(flow(atStep("style")));
    for (const s of ["Natural UGC", "Apresentação", "Oferta rápida", "Demonstração", "30s", "45s", "60s", "Econômico", "Equilibrado", "Premium", "Personalizar", "Estimativa: ~2.272 créditos"]) expect(t).toContain(s);
    expect(t).not.toContain("Balanceado");
  });

  it("personalizar: tom, CTA, ambiente, gênero (só automático) e voz — campos reais", () => {
    const html = renderToStaticMarkup(createElement(PersonalizeSheet, { open: true, onClose: () => undefined, draft: atStep("style").draft, set: () => undefined }));
    const t = text(html);
    for (const s of ["Tom", "Chamada final (CTA)", "Ambiente", "Quarto", "Gênero da apresentadora", "Voz", "Voz do próprio vídeo"]) expect(t).toContain(s);
    expect(html).toContain('value="Natural e espontâneo, como uma recomendação de amiga"');
    const chosen = text(renderToStaticMarkup(createElement(PersonalizeSheet, { open: true, onClose: () => undefined, draft: { ...atStep("style").draft, avatar: "avatar_cris" }, set: () => undefined })));
    expect(chosen).not.toContain("Gênero da apresentadora");
  });
});

describe("revisão e créditos", () => {
  it("resumo completo + estimativa ~N + saldo atual/após + CTA \"✦ Criar projeto · ~N créditos\"", () => {
    const html = flow(atStep("review"));
    const t = text(html);
    for (const s of ["Produto", "Secador", "Avatar", "Escolha automática", "Estilo", "Natural UGC", "Duração", "30s", "Qualidade", "Equilibrado", "Ideia", "Natural no quarto", "~2.272", "Saldo atual", "10.000", "Saldo estimado após", "~7.728"]) expect(t).toContain(s);
    expect(t).toContain("✦ Criar projeto · ~2.272 créditos");
    expect(t).toContain("Criar o projeto não gera custo");
    expect(t).not.toMatch(/(?<!~)2\.272 créditos/);
  });

  it("saldo insuficiente: necessário, disponível e sugestão mais barata; sem botão comprar", () => {
    const review = { estimated: 4032, provisional: false, remaining: 2100, after: 0, insufficient: true, cheaper: { duration: 60 as const, quality: "economy" as const, estimated: 2052 } };
    const t = text(renderToStaticMarkup(createElement(CreditsBox, { review, configured: true, onUse: () => undefined })));
    for (const s of ["Saldo insuficiente", "Necessário: ~4.032", "Disponível: 2.100", "Usar 60s · Econômico (~2.052)"]) expect(t).toContain(s);
    expect(t).not.toMatch(/comprar|pagar|assinar/i);
  });

  it("créditos não configurados: \"Créditos indisponíveis\", CTA sem número", () => {
    const html = flow(atStep("review"), null);
    expect(text(html)).toContain("Créditos indisponíveis.");
    expect(text(html)).toContain("✦ Criar projeto");
    expect(text(html)).not.toMatch(/Criar projeto · ~/);
  });

  it("geração não configurada: CTA desabilitado e aviso legível (tokens)", () => {
    const html = flow(atStep("review"), undefined, false);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-create-cta/);
    expect(html).toContain("text-warning");
  });

  it("revisão permite voltar a cada etapa", () => {
    const html = renderToStaticMarkup(createElement(ReviewStep, { draft: atStep("review").draft, avatars, review: null, dispatch: () => undefined, creditsConfigured: false }));
    for (const s of ["Editar produto", "Editar avatar", "Editar estilo", "Editar duração", "Editar qualidade", "Editar ideia"]) expect(html).toContain(`aria-label="${s}"`);
  });
});

describe("contraste no dark", () => {
  it("\"Serviço indisponível\" usa tokens do DS (nada de zinc fixo)", () => {
    const html = renderToStaticMarkup(createElement(ServiceUnavailable));
    expect(html).toContain("text-fg");
    expect(html).not.toMatch(/text-zinc-9\d\d|text-zinc-500/);
  });
});
