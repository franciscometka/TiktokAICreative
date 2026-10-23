import { describe, expect, it } from "vitest";
import { GENERATION_STATES, sceneFixture, scenesFixture, sourceFixture, v2Fixture } from "@/test/generation-fixtures";
import { buildGenerationView, generationCredits, previewFor, sceneItems, sceneProgress, withWorker } from "./generation-view";

/** L8.5 — view model da geração: estados, etapas reais, cenas, créditos, prévia, retry e worker. */

const build = (key: keyof typeof GENERATION_STATES, perBrl: number | null = 100) => buildGenerationView(GENERATION_STATES[key]!, { creditsPerBrl: perBrl });
const states = (v: ReturnType<typeof build>) => v.stages.map((s) => `${s.id}:${s.state}`);

describe("estados e etapas reais", () => {
  it("aguardando aprovação: \"Tudo pronto para começar\", estimativa e a MESMA ação de autorizar", () => {
    const v = build("awaiting_approval");
    expect(v).toMatchObject({ kind: "awaiting_approval", headline: "Tudo pronto para começar", credits: { mode: "estimate", estimated: 2012 }, action: { kind: "authorize", label: "Gerar vídeo", credits: 2012, disabled: false } });
    expect(states(v)).toEqual(["script:completed", "reference:upcoming", "fidelity:upcoming", "scenes:upcoming", "render:upcoming"]);
    expect(buildGenerationView({ ...GENERATION_STATES.awaiting_approval!, v2: v2Fixture({ phase: "ready_to_generate", quoteToken: null }) }, { creditsPerBrl: 100 }).action!.disabled).toBe(true);
  });

  it("aprovação do planejamento: só o roteiro, com a cotação do planejamento", () => {
    const v = buildGenerationView(sourceFixture({ v2: v2Fixture({ phase: "planning_approval", jobId: null }), planningQuote: { estimatedBrl: 0.35 }, authorization: null, actual: { totalBrl: 0, simulated: false } }), { creditsPerBrl: 100 });
    expect(v).toMatchObject({ kind: "awaiting_planning_approval", headline: "Tudo pronto para começar", credits: { mode: "estimate", estimated: 35 }, action: { kind: "start_planning", credits: 35 } });
    expect(v.stages[0]!.state).toBe("attention");
  });

  it("planejamento, referência, conferência, cenas e montagem", () => {
    expect(build("planning")).toMatchObject({ kind: "planning", headline: "Estamos criando seu vídeo", context: "Escrevendo o roteiro do seu vídeo..." });
    expect(states(build("planning"))[0]).toBe("script:active");
    expect(build("reference")).toMatchObject({ kind: "reference", context: "Mantendo a identidade da Cristina..." });
    expect(states(build("reference"))[1]).toBe("reference:active");
    const f = build("fidelity");
    expect(f).toMatchObject({ kind: "fidelity", headline: "Confira antes de continuar" });
    expect(states(f)).toEqual(["script:completed", "reference:completed", "fidelity:attention", "scenes:upcoming", "render:upcoming"]);
    expect(states(build("generating"))[3]).toBe("scenes:active");
    expect(build("rendering")).toMatchObject({ kind: "rendering", context: "Montando o vídeo final..." });
    expect(states(build("rendering"))).toEqual(["script:completed", "reference:completed", "fidelity:completed", "scenes:completed", "render:active"]);
  });

  it("mensagens só com fato: sem avatar com foto e sem especificações → nenhuma frase \"inteligente\"", () => {
    const v = buildGenerationView(sourceFixture({ presenterReady: false, identity: { strategy: "synthetic", avatarName: null }, specsCount: 0 }), { creditsPerBrl: 100 });
    expect(v.context).toBeNull();
    const specs = buildGenerationView(sourceFixture({ presenterReady: false, identity: { strategy: "synthetic", avatarName: null }, specsCount: 2 }), { creditsPerBrl: 100 });
    expect(specs.context).toBe("Preservando os detalhes do produto...");
  });

  it("concluído: \"Seu vídeo está pronto\", créditos usados SEM ~, MP4 final", () => {
    const v = build("done");
    expect(v).toMatchObject({ kind: "done", headline: "Seu vídeo está pronto", credits: { mode: "final", used: 1987 }, preview: { kind: "final", url: "/api/renders/c/k/r1" } });
    expect(v.stages.every((s) => s.state === "completed")).toBe(true);
    expect(v.summary).toEqual([{ label: "Avatar", value: "Cristina" }, { label: "Duração", value: "00:31" }, { label: "Qualidade", value: "Equilibrado" }]);
  });

  it("falha de cena: qual cena; retry só pela ação existente com cotação pronta", () => {
    const v = build("scene_failed");
    expect(v).toMatchObject({ kind: "scene_failed", headline: "Cena 4 não foi concluída", action: { kind: "retry_job", label: "Tentar novamente", credits: 398 } });
    expect(v.scenes.map((s) => s.status)).toEqual(["ready", "ready", "ready", "failed", "waiting"]);
    expect(v.stages[3]!.state).toBe("failed");
  });

  it("falha do job sem cotação utilizável → nenhum botão falso", () => {
    expect(build("job_failed")).toMatchObject({ kind: "job_failed", action: null });
  });

  it("blocked (operação paga incerta): pausa de segurança, sem retry", () => {
    const v = build("blocked");
    expect(v).toMatchObject({ kind: "blocked", headline: "Geração pausada por segurança", action: null, tone: "warning" });
    expect(v.subtext).toBe("O sistema não conseguiu confirmar o resultado de uma operação paga e pausou para evitar cobrança duplicada.");
    expect(v.details).toContain("sem confirmação");
    expect(v.stages.some((s) => s.state === "failed")).toBe(false);
  });
});

describe("cenas", () => {
  it("\"Gerando cena 3 de 5\": só a primeira não pronta está gerando; as outras aguardam", () => {
    const v = build("generating");
    expect(v.sceneCounter).toBe("Gerando cena 3 de 5");
    expect(v.context).toBe("Gerando a cena 3...");
    expect(v.scenes.map((s) => s.status)).toEqual(["ready", "ready", "generating", "waiting", "waiting"]);
    expect(v.sceneProgress).toEqual({ ready: 2, total: 5 });
  });

  it("abertura: cena 1 em geração = \"Criando a abertura...\"", () => {
    expect(buildGenerationView(sourceFixture({ scenes: scenesFixture(0) }), { creditsPerBrl: 100 }).context).toBe("Criando a abertura...");
  });

  it("sem cenas planejadas: nada de \"de N\" nem barra", () => {
    const v = buildGenerationView(sourceFixture({ scenes: [] }), { creditsPerBrl: 100 });
    expect(v.sceneCounter).toBeNull();
    expect(v.sceneProgress).toBeNull();
    expect(sceneProgress([])).toBeNull();
  });

  it("só cenas geradas no estágio de vídeo; duração real da cena", () => {
    const items = sceneItems([sceneFixture(1, "ready"), sceneFixture(2, "planned", { visualSource: "product_broll", isGenerated: true }), sceneFixture(3, "planned", { isGenerated: false })], false);
    expect(items.map((s) => s.number)).toEqual([1]);
    expect(items[0]!.durationSeconds).toBe(6);
  });
});

describe("sem porcentagem falsa", () => {
  it("nenhum número de % no view model; a única fração é cenas prontas / planejadas", () => {
    for (const key of Object.keys(GENERATION_STATES)) {
      const json = JSON.stringify(build(key as keyof typeof GENERATION_STATES));
      expect(json).not.toMatch(/\d+\s?%/);
    }
  });
});

describe("prévia só quando o arquivo existe", () => {
  it("final > cena pronta mais recente > nada", () => {
    expect(build("done").preview.kind).toBe("final");
    expect(build("generating").preview).toEqual({ kind: "scene", url: "/api/video/c/k/scene_2/v1", sceneNumber: 2 });
    expect(build("planning").preview).toEqual({ kind: "none" });
    // Cena "pronta" sem arquivo (simulada) não vira prévia.
    expect(previewFor(v2Fixture(), sceneItems([sceneFixture(1, "ready", { videoUrl: undefined })], true))).toEqual({ kind: "none" });
  });
});

describe("créditos (ledger real × estimativa)", () => {
  it("em andamento com custo real: \"real / ~estimativa\"", () => {
    expect(build("generating").credits).toEqual({ mode: "progress", real: 640, estimated: 2052 });
  });

  it("sem custo real ainda: só a estimativa (nunca \"0 / ~N\")", () => {
    expect(buildGenerationView(sourceFixture({ actual: { totalBrl: 0, simulated: false } }), { creditsPerBrl: 100 }).credits).toEqual({ mode: "estimate", estimated: 2052 });
  });

  it("mock nunca soma; créditos não configurados → null", () => {
    expect(generationCredits(sourceFixture({ actual: { totalBrl: 6.4, simulated: true } }), "generating", 100)).toEqual({ mode: "estimate", estimated: 2052 });
    expect(generationCredits(GENERATION_STATES.done!, "done", null)).toBeNull();
    expect(generationCredits({ ...GENERATION_STATES.done!, actual: { totalBrl: 0, simulated: true } }, "done", 100)).toBeNull();
  });
});

describe("worker", () => {
  it("offline com o job precisando do worker → \"Seu vídeo está na fila\" (âmbar), nunca erro", () => {
    const v = withWorker(build("generating"), { state: "offline", lastSeenAt: null });
    expect(v).toMatchObject({ kind: "queued", headline: "Seu vídeo está na fila", tone: "warning", sceneCounter: null });
    expect(v.subtext).toBe("O computador de geração está offline. O trabalho continua assim que ele voltar.");
    expect(v.stages.some((s) => s.state === "failed" || s.state === "active")).toBe(false);
    expect(v.scenes.some((s) => s.status === "generating")).toBe(false);
  });

  it("unknown não vira offline: só o aviso \"não verificado\"", () => {
    const v = withWorker(build("generating"), { state: "unknown", lastSeenAt: null });
    expect(v).toMatchObject({ kind: "generating", workerNotice: "unknown" });
  });

  it("worker não importa fora da geração (aprovação/concluído) nem no modo local", () => {
    expect(withWorker(build("awaiting_approval"), { state: "offline", lastSeenAt: null }).kind).toBe("awaiting_approval");
    expect(withWorker(build("done"), { state: "offline", lastSeenAt: null }).kind).toBe("done");
    expect(withWorker(build("generating"), { state: "local", lastSeenAt: null })).toMatchObject({ kind: "generating", workerNotice: null });
  });
});
