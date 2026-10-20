import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectV2View } from "@/application/project-v2-view";
import { isActive, NAV_FOOTER, NAV_MAIN } from "./app-shell";
import { CreateVideoForm } from "./create-video-form";
import { ProgressCard, ProjectV2Panel, ResultCard } from "./project-v2-panel";

const noop = async () => ({ ok: true as const });
const handlers = {
  startPlanning: noop, authorize: noop, approve: noop, regenerate: noop, retryScene: noop, retryPlanning: noop,
  estimateChange: async () => ({ ok: false as const, error: { message: "x" } }), refresh: () => undefined,
};
const steps = (["done", "current", "pending", "pending"] as const).map((state, i) => ({ id: (["script", "presenter", "video", "finish"] as const)[i]!, label: ["Preparando roteiro", "Preparando apresentadora", "Criando vídeo", "Finalizando"][i]!, state }));
const baseView: ProjectV2View = {
  phase: "generating", title: "Secador", progress: steps, headline: "Gerando seu vídeo.", estimate: null, approval: null, error: null, result: null,
  avatar: { name: "Marina", reason: "Marina escolhido automaticamente: padrão para cabelo." }, voice: { label: "Voz do próprio vídeo", reason: "Voice Lock indisponível com este provider." }, jobId: "job_1", quoteToken: "tok",
};

describe("UI V2 (Lote 6)", () => {
  it("navegação: Início, Criar vídeo, Projetos, Avatares | Configurações", () => {
    expect(NAV_MAIN.map((n) => n.label)).toEqual(["Início", "Criar vídeo", "Projetos", "Avatares"]);
    expect(NAV_FOOTER.map((n) => n.label)).toEqual(["Configurações"]);
    expect(isActive("/campaigns/abc", "/projects")).toBe(true);
    expect(isActive("/avatars/new", "/avatars")).toBe(true);
    expect(isActive("/avatars", "/")).toBe(false);
  });

  it("Create V2: poucos campos visíveis; Personalizar e Avançado recolhidos; nada técnico fora do avançado", () => {
    const html = renderToStaticMarkup(createElement(CreateVideoForm, {
      productId: "prod_1", avatars: [{ id: "avatar_m", name: "Marina", imageUrl: null, tags: ["cabelo"] }],
      estimates: [{ duration: 30, quality: "high", clips: 5, totalBrl: 23.4, lines: [{ label: "Vídeo (5 trechos)", brl: 22 }], provisional: false }],
      planningAvailable: true, Uploader: () => createElement("div", null, "UPLOADER"), submit: async () => ({ ok: true as const, value: { campaignId: "c" } }), onCreated: () => undefined,
    }));
    for (const text of ["UPLOADER", "Nome do produto", "O que você quer criar?", "Avatar", "Automático", "Marina", "Duração", "30s", "45s", "60s", "Estilo", "UGC Natural", "Gerar vídeo", "Estimativa: R$"]) expect(html).toContain(text);
    expect(html).toMatch(/<details[^>]*data-section="personalize"/);
    expect(html).not.toMatch(/<details[^>]*open/);
    const advanced = html.indexOf('data-section="advanced"');
    expect(advanced).toBeGreaterThan(0);
    const main = html.slice(0, html.indexOf('data-section="personalize"'));
    expect(main).not.toMatch(/provider|modelo|readiness|ledger|Veo|Krea|MOCK/i);
    // Detalhamento do custo escondido por padrão.
    expect(html).not.toContain("Detalhes da estimativa");
  });

  it("progresso: 4 passos com ✓ ● ○ e aviso de alguns minutos", () => {
    const html = renderToStaticMarkup(createElement(ProgressCard, { steps }));
    expect(html).toContain("Gerando seu vídeo");
    for (const label of ["Preparando roteiro", "Preparando apresentadora", "Criando vídeo", "Finalizando", "✓", "●", "○", "Pode levar alguns minutos."]) expect(html).toContain(label);
    expect(html).toContain('role="progressbar"');
  });

  it("result page: player 9:16, duração, custo, baixar, outra versão e pedido de mudança", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { campaignId: "c1", onEstimate: handlers.estimateChange, result: { videoUrl: "/api/renders/c1/k/r1", downloadUrl: "/api/renders/c1/k/r1?download=1", durationLabel: "00:36", costLabel: "R$ 12,34" } }));
    for (const text of ["Seu vídeo está pronto", "00:36", "R$ 12,34", "Baixar vídeo", "Gerar outra versão", "Quer mudar alguma coisa?", "Deixe a fala mais natural...", "Atualizar vídeo", "aspect-[9/16]"]) expect(html).toContain(text);
  });

  it("erro amigável com Tentar novamente; detalhes técnicos só ao clicar", () => {
    const html = renderToStaticMarkup(createElement(ProjectV2Panel, {
      campaignId: "c1", advancedHref: "/campaigns/c1?view=advanced", handlers,
      view: { ...baseView, phase: "failed", error: { message: "Não conseguimos gerar o trecho 3.", details: "ProviderError: HTTP 500 ZodError", retry: "job" } },
    }));
    expect(html).toContain("Não conseguimos gerar o trecho 3.");
    expect(html).toContain("Tentar novamente");
    expect(html).toContain("Ver detalhes");
    expect(html).not.toContain("ZodError");
    expect(html).toContain("Detalhes técnicos");
    expect(html).toContain('href="/campaigns/c1?view=advanced"');
  });

  it("aprovação simples: checklist do produto, sem estados técnicos", () => {
    const html = renderToStaticMarkup(createElement(ProjectV2Panel, {
      campaignId: "c1", advancedHref: "#", handlers,
      view: { ...baseView, phase: "product_check", approval: { kind: "product", title: "Confira o produto", imageUrl: "/api/ugc/x", referenceId: "ugcref_1", checklist: ["Cor e formato corretos", "Logo/textos corretos", "Especificações corretas"], canGenerateOther: true, simulated: false } },
    }));
    for (const text of ["Confira o produto", "Cor e formato corretos", "Logo/textos corretos", "Especificações corretas", "Confirmar", "Gerar outra"]) expect(html).toContain(text);
    // data-state="pending" é atributo do progresso; nenhum estado técnico aparece como TEXTO.
    expect(html).not.toMatch(/needs_review|ugcref_1|>\s*(pending|approved)\s*</);
  });
});
