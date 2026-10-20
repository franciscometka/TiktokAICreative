import { StageExecutionPanel } from "@/components/campaign/stage-execution-panel";
import { WorkflowPanel } from "@/components/campaign/workflow-panel";
import type { Metadata } from "next";
import Link from "next/link";
import { getCampaignView } from "@/application/campaign-actions";
import type { CampaignView } from "@/application/campaign-view";
import { formatSecondsRange } from "@/application/cost-presentation";
import { AutoRefresh } from "@/components/campaign/auto-refresh";
import { CampaignCostSummary, CostApprovalSection } from "@/components/campaign/cost-sections";
import { CreativeSection } from "@/components/campaign/creative-section";
import { PlanningFailure } from "@/components/campaign/planning-failure";
import { PlanningProgress } from "@/components/campaign/planning-progress";
import { AnalysisSection, ConceptsSection, HooksSection } from "@/components/campaign/review-sections";
import { campaignStateTone } from "@/components/campaign/status";
import { Stepper, stepsFor, type StepState } from "@/components/stepper";
import { Badge, buttonClasses, Notice, Panel, SectionHeading } from "@/components/ui/primitives";
import { formatBrl } from "@/lib/money";
import { getPublicConfig, getRuntime } from "@/server/runtime";
import { ReadinessPanel } from "@/components/readiness-panel";
import { SimpleVideoWorkspace } from "@/components/campaign/simple-video-workspace";
import { buildProjectV2View } from "@/application/project-v2-view";
import { ProjectV2 } from "@/components/v2/project-v2";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const result = await getCampaignView(getRuntime().deps, id);
  return { title: `${result.ok ? result.value.product.name : "Campanha"} · Creative Factory` };
}

function stepStates(view: CampaignView): StepState[] {
  if (view.planningQuote?.ready && view.planning.runs === 0) return ["done", "done", "current"];
  switch (view.state) {
    case "planning":
      return ["done", "done", "current"];
    case "interrupted":
    case "failed":
      return ["done", "done", "error"];
    case "planned": {
      const open = view.creatives.some((c) => c.canApprove || c.budgetDecision || c.activity || c.interrupted);
      // Revisão e aprovação ficam na mesma página; a etapa atual é a aprovação enquanto houver o que decidir.
      return ["done", "done", "done", "done", open ? "current" : "done"];
    }
  }
}

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  const { id } = await params;
  const { view: viewMode } = await searchParams;
  const publicConfig = getPublicConfig();
  const result = await getCampaignView(getRuntime().deps, id);

  if (!result.ok) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <Notice tone={result.error.code === "corrupted" ? "red" : "neutral"} title={result.error.title}>
          {result.error.message}
        </Notice>
        <Link href="/campaigns" className={`${buttonClasses("secondary", "md")} mt-4`}>
          Ver campanhas
        </Link>
      </main>
    );
  }

  const view = result.value;
  // Lote 6: projetos da UX V2 abrem na tela simples; "Detalhes técnicos" (?view=advanced) mostra tudo.
  // Projetos antigos (sem uxVersion) continuam na tela completa de sempre.
  if (view.uxVersion === 2 && viewMode !== "advanced") {
    const v2 = buildProjectV2View(view);
    const busy = v2.phase === "planning" || v2.phase === "generating";
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
        {busy && <AutoRefresh intervalMs={3_000} />}
        <ProjectV2 view={v2} campaignId={view.id} />
      </main>
    );
  }
  const planned = view.state === "planned";
  const created = new Date(view.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <nav className="text-sm text-zinc-500" aria-label="Navegação">
        <Link href={view.uxVersion === 2 ? `/campaigns/${view.id}` : "/projects"} className="hover:text-zinc-900">
          {view.uxVersion === 2 ? "← Voltar à visão simples" : "Projetos"}
        </Link>
        <span className="mx-2 text-zinc-300">/</span>
        <span className="text-zinc-700">{view.product.name}</span>
      </nav>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words text-zinc-900">{view.projectName || view.product.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-600">
            <span>{view.strategy.qualityLabel}</span>
            <span className="text-zinc-300">·</span>
            <span>
              {view.strategy.llmModelName}
              {view.planning.simulated && " (simulado)"}
            </span>
            <span className="text-zinc-300">·</span>
            <span>
              {view.strategy.creativeCount} criativo{view.strategy.creativeCount > 1 ? "s" : ""}
            </span>
            <span className="text-zinc-300">·</span>
            <span>{view.strategy.styleSelection === "auto" ? "Formatos AUTO" : view.strategy.styleLabels.join(", ")}</span>
            <span className="text-zinc-300">·</span>
            <span>{created}</span>
          </p>
        </div>
        <Badge tone={campaignStateTone(view.state)} dot>
          {view.statusLabel}
        </Badge>
      </div>

      <div className="mt-6">
        <Stepper steps={stepsFor(stepStates(view), planned ? [undefined, undefined, undefined, "#analise", "#custo"] : [])} />
      </div>
      {view.videoConcept ? <p className="mt-4 max-w-3xl text-sm leading-relaxed text-zinc-600">{view.videoConcept}</p> : null}
      {view.offlineReadOnly ? <div className="mt-6"><Notice title="Projeto anterior em consulta">
        Os dados e custos originais foram preservados. Crie uma cópia para escolher modos por etapa.
        <Link href={`/create?from=${view.id}`} className={`${buttonClasses("secondary", "sm")} mt-3`}>Criar cópia híbrida para continuar</Link>
      </Notice></div> : null}
      {!planned && view.stageCapabilities && view.planningQuote ? <div className="mt-6"><StageExecutionPanel campaignId={id} quotes={[view.planningQuote]} capabilities={view.stageCapabilities} /></div> : null}
      {view.planning.simulated && (
        <div className="mt-6">
          <Notice title="Planejamento simulado">
            Planejamento e roteiro sugeridos localmente para testar o fluxo. Nenhum serviço de IA foi chamado; revise o conteúdo antes de uma futura geração real.
          </Notice>
        </div>
      )}

      {view.state === "planning" && (
        <div className="mt-6 max-w-3xl">
          <PlanningProgress
            startedAt={view.planning.startedAt}
            model={view.strategy.llmModelName}
            qualityLabel={view.strategy.qualityLabel}
            creativeCount={view.strategy.creativeCount}
            simulated={view.planning.simulated}
            runs={view.planning.runs}
          />
        </div>
      )}

      {(view.state === "failed" || view.state === "interrupted") && view.error && (
        <div className="mt-6 max-w-3xl">
          <PlanningFailure
            campaignId={view.id}
            error={view.error}
            detail={view.error.detail}
            simulated={view.planning.simulated}
            planningAvailable={publicConfig.planningAvailable && !view.offlineReadOnly}
          />
        </div>
      )}

      {planned && view.creatives.some((c) => c.activity) && <AutoRefresh />}

      {planned && <section className="mt-8 space-y-12" aria-label="Prévia e geração do vídeo">
        {view.creatives.map((creative) => <SimpleVideoWorkspace key={creative.id} campaignId={view.id} creative={creative} productImages={view.product.images} />)}
      </section>}

      {planned && (
        <details className="mt-10 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-800">Configurações avançadas e detalhes técnicos</summary>
          <div className="mt-5 space-y-5">
            <ReadinessPanel readiness={publicConfig.readiness} compact />
            {view.stageCapabilities ? view.creatives.map(c => c.stageQuotes ? <StageExecutionPanel jobId={c.jobId} campaignId={id} quotes={c.stageQuotes} capabilities={view.stageCapabilities!} key={c.id} /> : null) : null}
            <section className="space-y-4" aria-label="Jobs do projeto">{view.creatives.map(creative => <WorkflowPanel key={creative.id} creative={creative} />)}</section>
          </div>
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-10">
            {view.analysis && <AnalysisSection analysis={view.analysis} />}
            <HooksSection hooks={view.hooks} />
            <ConceptsSection creatives={view.creatives} />
            <section id="criativos" className="scroll-mt-20 space-y-4">
              <SectionHeading
                title="Criativos"
                description={`Meta do preset: ${formatSecondsRange(view.strategy.finalVideoSeconds)} finais com ${formatSecondsRange(view.strategy.generatedVideoSeconds)} de vídeo IA.`}
              />
              <div className="space-y-6">
                {view.creatives.map((c) => (
                  <CreativeSection key={c.id} creative={c} />
                ))}
              </div>
            </section>
            <CostApprovalSection
              creatives={view.creatives}
              mediaIsMock={publicConfig.mediaIsMock}
              rendererIsReal={publicConfig.renderer === "remotion"}
            />
          </div>

          <aside className="order-first space-y-4 lg:order-none">
            <div className="space-y-4 lg:sticky lg:top-20">
              <CampaignCostSummary view={view} />
              <Panel className="p-5">
                <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Produto</p>
                {view.product.images.length > 0 && (
                  <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {view.product.images.map((image, i) => (
                      // eslint-disable-next-line @next/next/no-img-element -- imagem local servida por /api/uploads
                      <img
                        key={image.id}
                        src={image.previewUrl}
                        alt={`Imagem ${i + 1} do produto`}
                        className="aspect-square w-full rounded border border-zinc-200 object-cover"
                      />
                    ))}
                  </div>
                )}
                <p className="mt-3 line-clamp-4 text-sm text-zinc-600">{view.product.description}</p>
                <dl className="mt-3 space-y-1 text-sm">
                  {view.product.priceBrl !== undefined && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-zinc-500">Preço</dt>
                      <dd className="font-medium tabular">{formatBrl(view.product.priceBrl)}</dd>
                    </div>
                  )}
                </dl>
                <Link href={`/create?from=${view.id}`} className={`${buttonClasses("secondary", "sm")} mt-4 w-full`}>
                  Planejar de novo com ajustes
                </Link>
              </Panel>
              <nav className="hidden text-sm lg:block" aria-label="Nesta página">
                <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Nesta página</p>
                <ul className="mt-2 space-y-1.5 text-zinc-600">
                  <li><a className="hover:text-zinc-900" href="#analise">Análise</a></li>
                  <li><a className="hover:text-zinc-900" href="#hooks">Hooks</a></li>
                  <li><a className="hover:text-zinc-900" href="#conceitos">Conceitos</a></li>
                  {view.creatives.map((c) => (
                    <li key={c.id}>
                      <a className="hover:text-zinc-900" href={`#criativo-${c.number}`}>
                        Criativo {String(c.number).padStart(2, "0")}
                      </a>
                    </li>
                  ))}
                  <li><a className="font-medium text-zinc-900" href="#custo">Custo e aprovação</a></li>
                </ul>
              </nav>
            </div>
          </aside>
        </div>
        </details>
      )}
    </main>
  );
}
