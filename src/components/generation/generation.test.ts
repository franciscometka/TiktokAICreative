import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShellStatus } from "@/app/api/shell/route";
import { buildGenerationView } from "@/application/generation-view";
import { GENERATION_STATES } from "@/test/generation-fixtures";
import { isDarkRoute } from "../shell/nav";
import { ShellStatusContext } from "../shell/shell-status-context";
import { GenerationScreen } from "./generation-screen";
import { PreviewPlayer } from "./preview-player";
import { SceneTimeline } from "./scene-timeline";

/** L8.5 — tela de geração: cada estado tem a sua apresentação; ações só quando existem. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = async () => ({ ok: true as const });
const handlers = { startPlanning: noop, authorize: noop, approve: noop, regenerate: noop, retryScene: noop, retryPlanning: noop, estimateChange: async () => ({ ok: false as const, error: { message: "x" } }), refresh: () => undefined };
const shell = (worker: ShellStatus["worker"]["state"] = "online", mode: ShellStatus["mode"] = "cloud"): ShellStatus => ({ mode, worker: { state: worker, lastSeenAt: null }, user: null, credits: { creditsPerBrl: 100, remaining: 8000, allowance: 10_000, state: "normal", estimatedVideos: null } });
const screen = (key: keyof typeof GENERATION_STATES, status: ShellStatus | null = shell()) =>
  renderToStaticMarkup(createElement(ShellStatusContext.Provider, { value: { status, now: new Date(0) } },
    createElement(GenerationScreen, { source: GENERATION_STATES[key]!, campaignId: "c1", handlers, advancedHref: "/campaigns/c1?view=advanced" })));

describe("tela por estado", () => {
  it("aguardando aprovação: resumo, estimativa, créditos e o botão de aprovação (sem gerar sozinho)", () => {
    const html = screen("awaiting_approval");
    const t = text(html);
    for (const s of ["Tudo pronto para começar", "Estimativa: R$ 20,12", "~2.012 créditos estimados", "Nenhuma cena é gerada antes da sua aprovação."]) expect(t).toContain(s);
    expect(html).toMatch(/data-approve[^>]*>.*Gerar vídeo · ~2\.012 créditos/);
    expect(html).toContain('data-generation="awaiting_approval"');
  });

  it("gerando: ✦ headline, \"Gerando cena 3 de 5\", contexto real, real / ~estimativa", () => {
    const t = text(screen("generating"));
    for (const s of ["✦ Estamos criando seu vídeo", "Acompanhe cada etapa enquanto o Creative Factory monta seu conteúdo.", "Gerando cena 3 de 5", "Gerando a cena 3...", "2 de 5 cenas prontas", "640 / ~2.052 créditos"]) expect(t).toContain(s);
  });

  it("Product Fidelity: comparação, checklist completo e confirmação bloqueada até marcar tudo", () => {
    const html = screen("fidelity");
    const t = text(html);
    for (const s of ["Confira Cristina com o produto", "Foto de Cristina", "Referência gerada", "Seu produto", "É Cristina: mesmo rosto da foto do avatar", "“2100W” igual ao produto", "Aguardando revisão", "Gerar outra"]) expect(t).toContain(s);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirmar<\/button>/);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(5);
  });

  it("concluído: player final, créditos utilizados sem ~ e as 3 ações (sem variação)", () => {
    const html = screen("done");
    const t = text(html);
    for (const s of ["✦ Seu vídeo está pronto", "1.987 créditos utilizados", "Baixar vídeo", "Criar outro vídeo", "Voltar aos projetos"]) expect(t).toContain(s);
    expect(html).toContain('href="/api/renders/c/k/r1?download=1"');
    expect(html).toMatch(/<video[^>]*src="\/api\/renders\/c\/k\/r1"/);
    expect(t).not.toMatch(/~1\.987|variação/i);
  });

  it("cena falhou: qual cena e retry com cotação; job sem cotação: nenhum botão", () => {
    const t = text(screen("scene_failed"));
    expect(t).toContain("Cena 4 não foi concluída");
    expect(t).toContain("Tentar novamente · ~398 créditos");
    expect(screen("job_failed")).not.toMatch(/data-retry/);
  });

  it("blocked: pausa por segurança, nenhuma nova tentativa", () => {
    const html = screen("blocked");
    const t = text(html);
    expect(t).toContain("Geração pausada por segurança");
    expect(t).toContain("pausou para evitar cobrança duplicada");
    expect(html).not.toMatch(/data-retry|Tentar novamente/);
    expect(html).toContain('href="/campaigns/c1?view=advanced"');
  });

  it("worker offline: \"Seu vídeo está na fila\" (âmbar), sem erro", () => {
    const html = screen("generating", shell("offline"));
    expect(text(html)).toContain("Seu vídeo está na fila");
    expect(html).toContain('data-worker-notice="offline"');
    expect(html).not.toMatch(/text-danger/);
  });

  it("worker unknown: \"Status do worker não verificado\", sem chamar de offline", () => {
    const t = text(screen("generating", shell("unknown")));
    expect(t).toContain("Status do worker não verificado.");
    expect(t).not.toContain("offline");
    expect(t).toContain("Estamos criando seu vídeo");
  });

  it("modo local: worker local não muda nada; créditos ainda carregando = skeleton", () => {
    expect(text(screen("generating", shell("local", "local")))).toContain("Estamos criando seu vídeo");
    expect(screen("generating", null)).toContain("animate-shimmer");
  });

  it("acessível: etapas como lista ordenada, aria-live curto, cenas em tablist", () => {
    const html = screen("generating");
    expect(html).toContain('<ol aria-label="Etapas da geração"');
    expect(html).toContain('aria-current="step"');
    expect(html).toMatch(/<p class="sr-only" aria-live="polite">Estamos criando seu vídeo\. Gerando cena 3 de 5<\/p>/);
    expect(html).toContain('role="tablist"');
    expect((html.match(/aria-live=/g) ?? []).length).toBe(1);
  });
});

describe("prévia e timeline", () => {
  it("skeleton 9:16 sem mídia; um único <video> quando há arquivo", () => {
    const none = renderToStaticMarkup(createElement(PreviewPlayer, { preview: { kind: "none" }, title: "x", active: true }));
    expect(none).not.toContain("<video");
    expect(none).toContain("aspect-[9/16]");
    const scene = renderToStaticMarkup(createElement(PreviewPlayer, { preview: { kind: "scene", url: "/api/video/a", sceneNumber: 2 }, title: "x", active: true }));
    expect((scene.match(/<video/g) ?? []).length).toBe(1);
    expect(scene).toContain('preload="metadata"');
    expect(scene).not.toContain("autoplay");
  });

  it("timeline: número, duração e status; só a cena selecionada recebe player; fala/visual/movimento", () => {
    const view = buildGenerationView(GENERATION_STATES.generating!, { creditsPerBrl: 100 });
    const html = renderToStaticMarkup(createElement(SceneTimeline, { scenes: view.scenes, defaultSelected: "scene_1" }));
    const t = text(html);
    for (const s of ["Cena 1", "Cena 5", "6s", "Pronta", "Gerando", "Aguardando", "Fala", "Descrição visual", "Movimento", "Câmera na mão"]) expect(t).toContain(s);
    expect((html.match(/<video/g) ?? []).length).toBe(1);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"/);
    expect(html).not.toMatch(/Regenerar|Editar/);
  });

  it("projeto é rota dark; ?view=advanced segue na ilha clara (LegacyIsland na página)", () => {
    expect(isDarkRoute("/campaigns/abc")).toBe(true);
  });
});
