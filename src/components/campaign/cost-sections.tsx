import { formatSeconds } from "@/application/cost-presentation";
import type { CampaignView, CreativeView } from "@/application/campaign-view";
import { formatBrl } from "@/lib/money";
import { Badge, InfoTip, Notice, Panel, ProvisionalBadge, SectionHeading } from "../ui/primitives";
import { ApprovalControls } from "./approval-controls";
import { NarrationPanel } from "./narration-panel";
import { RenderPanel } from "./render-panel";
import { jobStatusTone } from "./status";

/**
 * Custos. Regra visual: "já utilizado" (real, ledger) e "futuro estimado" nunca se misturam
 * na mesma lista; o total projetado é a única soma dos dois e vem pronto do domínio.
 */

function Line({ label, value, extra, muted }: { label: string; value: string; extra?: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-zinc-700">
        {label}
        {extra}
      </dt>
      <dd className={muted ? "text-sm text-zinc-500 tabular" : "text-sm font-medium text-zinc-900 tabular"}>{value}</dd>
    </div>
  );
}

function SimulatedTag() {
  return (
    <InfoTip label="Valor calculado pelo planejador simulado (LLM_PROVIDER=mock). Nenhum dinheiro foi gasto.">
      <Badge>simulado</Badge>
    </InfoTip>
  );
}

export function CreativeCostCard({
  creative,
  mediaIsMock,
  rendererIsReal,
}: {
  creative: CreativeView;
  mediaIsMock: boolean;
  rendererIsReal: boolean;
}) {
  const estimate = creative.estimate;
  const n = String(creative.number).padStart(2, "0");
  return (
    <Panel id={`custo-${creative.number}`} className="scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Criativo {n}</p>
          <p className="truncate font-medium text-zinc-900">{creative.concept.title}</p>
        </div>
        {creative.jobStatus && (
          <Badge tone={jobStatusTone(creative.jobStatus, creative.interrupted)} dot>
            {creative.jobStatusLabel}
          </Badge>
        )}
      </div>

      {estimate ? (
        <div className="space-y-5 p-5 sm:p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-md border border-zinc-200 p-4">
              <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Custo já utilizado</p>
              <dl className="mt-2">
                <Line
                  label={estimate.incurred.label}
                  value={formatBrl(estimate.incurred.brl)}
                  extra={estimate.incurred.simulated ? <SimulatedTag /> : undefined}
                />
              </dl>
              <p className="mt-2 text-xs text-zinc-500">
                {estimate.incurred.simulated ? "Valor simulado; nenhum dinheiro foi gasto." : `Custo real${estimate.incurred.sharedAmongCreatives > 1 ? `, rateado entre ${estimate.incurred.sharedAmongCreatives} criativos` : ""}. Não volta se você cancelar.`}
              </p>
            </div>
            <div className="rounded-md border border-zinc-200 p-4">
              <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Custo futuro estimado</p>
              <dl className="mt-2 divide-y divide-zinc-100">
                {estimate.future.map((line) => (
                  <Line key={line.category} label={line.label} value={formatBrl(line.brl)} extra={line.isPlaceholder ? <ProvisionalBadge /> : undefined} />
                ))}
              </dl>
              <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 text-sm">
                <span className="font-medium">{creative.canApprove ? "Subtotal a aprovar" : "Subtotal estimado"}</span>
                <span className="font-semibold tabular">{formatBrl(estimate.futureTotalBrl)}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4 rounded-md bg-zinc-50 px-4 py-3">
            <div>
              <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Total projetado</p>
              <p className="text-2xl font-semibold tracking-tight tabular">{formatBrl(estimate.projectedTotalBrl)}</p>
            </div>
            <dl className="flex gap-6 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Vídeo final</dt>
                <dd className="font-medium tabular">{formatSeconds(estimate.finalVideoSeconds)}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Vídeo gerado por IA</dt>
                <dd className="font-medium text-blue-700 tabular">{formatSeconds(estimate.generatedVideoSeconds)}</dd>
              </div>
            </dl>
          </div>

          <NarrationPanel jobId={creative.jobId} narration={creative.narration} />
          <RenderPanel creative={creative} rendererIsReal={rendererIsReal} />
          {creative.actual && (
            <dl className="rounded-md border border-zinc-200 px-4 py-2">
              <Line
                label="Mídia já executada"
                value={formatBrl(creative.actual.mediaBrl)}
                extra={creative.actual.simulated ? <SimulatedTag /> : undefined}
              />
              {creative.actual.discardedBrl > 0 && <Line label="Inclui tentativas descartadas" value={formatBrl(creative.actual.discardedBrl)} muted />}
            </dl>
          )}
          {creative.jobStatus === "failed" && creative.error && (
            <Notice tone="red" title="A geração falhou">
              {creative.error}
            </Notice>
          )}

          {creative.jobId && (!creative.hybrid || creative.stageQuotes?.every(q => q.mode === "mock")) && (
            <ApprovalControls
              jobId={creative.jobId}
              estimateId={estimate.estimateId}
              futureTotalBrl={estimate.futureTotalBrl}
              canApprove={creative.canApprove}
              canCancel={creative.canCancel}
              mediaIsMock={mediaIsMock}
              audioIsReal={creative.narration.isReal}
              rendererIsReal={rendererIsReal}
              pendingDecision={creative.budgetDecision}
            />
          )}
        </div>
      ) : (
        <p className="p-5 text-sm text-zinc-500">Sem estimativa para este criativo.</p>
      )}
    </Panel>
  );
}

export function CostApprovalSection({
  creatives,
  mediaIsMock,
  rendererIsReal,
}: {
  creatives: CreativeView[];
  mediaIsMock: boolean;
  rendererIsReal: boolean;
}) {
  return (
    <section id="custo" className="scroll-mt-20 space-y-4">
      <SectionHeading
        eyebrow="Custo e aprovação"
        title="Aprovar geração"
        description="Cada criativo é aprovado separadamente, pelo valor estimado exibido. Recalcular a estimativa invalida a aprovação."
      />
      <div className="space-y-4">
        {creatives.map((c) => (
          <CreativeCostCard key={c.id} creative={c} mediaIsMock={mediaIsMock} rendererIsReal={rendererIsReal} />
        ))}
      </div>
    </section>
  );
}

/** Resumo fixo da campanha (lateral no desktop). */
export function CampaignCostSummary({ view }: { view: CampaignView }) {
  const { costs, budget } = view;
  return (
    <Panel className="p-5">
      <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Custo da campanha</p>
      <dl className="mt-3">
        <p className="text-xs font-medium text-zinc-500">Já utilizado</p>
        <Line
          label="Planejamento Claude"
          value={formatBrl(costs.actual.planningBrl)}
          extra={costs.actual.simulated ? <SimulatedTag /> : undefined}
        />
        {costs.actual.mediaBrl > 0 && <Line label="Mídia" value={formatBrl(costs.actual.mediaBrl)} />}
        <p className="mt-3 text-xs font-medium text-zinc-500">Futuro estimado</p>
        <Line
          label="Criativos a aprovar"
          value={formatBrl(costs.pendingFutureBrl)}
          extra={costs.containsPlaceholderPrices ? <ProvisionalBadge /> : undefined}
        />
      </dl>
      <div className="mt-3 flex items-baseline justify-between border-t border-zinc-200 pt-3">
        <span className="text-sm font-medium">Total projetado</span>
        <span className="text-xl font-semibold tracking-tight tabular">{formatBrl(costs.projectedBrl)}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-3 text-sm">
        <div>
          <dt className="text-xs text-zinc-500">Limite por criativo</dt>
          <dd className="font-medium tabular">{formatBrl(budget.maxCostPerCreativeBrl)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Limite da campanha</dt>
          <dd className="font-medium tabular">{formatBrl(budget.maxCostPerCampaignBrl)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-zinc-500">
        {budget.allowOverBudget ? "Você pode autorizar exceder o limite, sempre com confirmação." : "Exceder o limite não é permitido nesta campanha."}
      </p>
    </Panel>
  );
}
