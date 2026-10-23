"use client";

import { ArrowLeft, Info, PauseCircle, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { buildGenerationView, withWorker, type GenerationCredits, type GenerationSource, type GenerationView } from "@/application/generation-view";
import { formatCredits } from "@/costs/credits";
import { AmbientGlow, Button, buttonClass, Card, cx, focusRing, interactive, Progress, Skeleton, Spark } from "../ds";
import { useShellStatusContext } from "../shell/shell-status-context";
import type { ProjectV2Handlers } from "../v2/project-v2-panel";
import { FidelityPanel } from "./fidelity-panel";
import { ResultStudio } from "./result-studio";
import { PreviewPlayer } from "./preview-player";
import { SceneTimeline } from "./scene-timeline";
import { StageStepper } from "./stage-stepper";

/**
 * L8.5 — experiência de geração (Cinematic AI Studio). A tela recebe o recorte REAL do projeto
 * (`GenerationSource`) e monta tudo com `buildGenerationView` (puro, testado). Worker e fator de
 * créditos vêm do status que o shell JÁ consulta (sem polling extra). As ações são as MESMAS do
 * Lote 6 (aprovação explícita, Product Fidelity, retry só com cotação) — injetadas pelo wrapper.
 */

type Outcome = Awaited<ReturnType<ProjectV2Handlers["authorize"]>>;

/** Barra de cenas só depois que a etapa de cenas começou (antes seria "0 de N" sem sentido). */
const SCENE_PROGRESS_KINDS = new Set<GenerationView["kind"]>(["generating", "rendering", "queued", "scene_failed", "job_failed", "blocked"]);
const PROGRESS_KINDS = new Set<GenerationView["kind"]>(["planning", "reference", "generating", "rendering"]);

export function creditsLabel(credits: GenerationCredits): string {
  if (credits.mode === "progress") return `${formatCredits(credits.real)} / ~${formatCredits(credits.estimated)} créditos`;
  if (credits.mode === "estimate") return `~${formatCredits(credits.estimated)} créditos estimados`;
  return `${formatCredits(credits.used)} créditos utilizados`;
}

export function GenerationScreen({ source, campaignId, handlers, advancedHref }: { source: GenerationSource; campaignId: string; handlers: ProjectV2Handlers; advancedHref: string }) {
  const { status } = useShellStatusContext();
  const view = withWorker(buildGenerationView(source, { creditsPerBrl: status?.credits?.creditsPerBrl ?? null }), status?.mode === "cloud" ? status.worker : null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>();
  const run = (action: () => Promise<Outcome>) => startTransition(async () => {
    const r = await action();
    setMessage(r.ok ? undefined : r.error?.message ?? "Não foi possível continuar.");
    handlers.refresh();
  });
  const v2 = source.v2;
  const progress = PROGRESS_KINDS.has(view.kind);

  function act() {
    const a = view.action!;
    run(() => {
      if (a.kind === "start_planning") return handlers.startPlanning(v2.quoteToken!);
      if (a.kind === "authorize" || a.kind === "retry_job") return handlers.authorize(v2.jobId!, v2.quoteToken!);
      if (a.kind === "retry_scene") return handlers.retryScene(v2.jobId!, v2.error!.sceneId!, v2.error!.sceneToken!);
      return handlers.retryPlanning();
    });
  }

  // L8.6: concluído = Result Studio na MESMA rota (a tela muda conforme o estado).
  if (view.kind === "done" && v2.result) {
    return <ResultStudio view={view} source={source} campaignId={campaignId} onEstimate={handlers.estimateChange} localMode={status?.mode === "local"} advancedHref={advancedHref} />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-12 sm:px-8 sm:pt-10" data-generation={view.kind}>
      <Link href="/projects" className={cx("inline-flex items-center gap-1.5 text-caption font-medium text-fg-subtle hover:text-fg", interactive, focusRing)}><ArrowLeft className="size-3.5" aria-hidden />Projetos</Link>

      {/* Anúncio curto e só quando o texto muda (nunca a cada poll). */}
      <p className="sr-only" aria-live="polite">{[view.headline, view.sceneCounter].filter(Boolean).join(". ")}</p>

      <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <PreviewPlayer preview={view.preview} title={view.title} active={progress} />
        </div>

        <div className="min-w-0 space-y-6">
          <header className="relative isolate">
            {view.kind === "done" ? <AmbientGlow className="-top-10 [mask-image:linear-gradient(to_bottom,#000_40%,transparent)]" /> : null}
            <p className="truncate text-caption font-medium text-fg-subtle">{view.title}</p>
            <h1 className="mt-1 flex items-center gap-2.5 text-[26px] leading-tight font-semibold tracking-tight text-fg sm:text-title" data-headline>
              {progress || view.kind === "done" ? <Spark active={progress} gradient /> : null}
              <span key={view.kind} className="animate-fade-in">{view.headline}</span>
            </h1>
            {view.subtext ? <p className="mt-2 max-w-xl text-body text-fg-muted">{view.subtext}</p> : null}
            {v2.avatar ? <p className="mt-2 text-caption text-fg-subtle">{v2.avatar.label}</p> : null}
          </header>

          {view.kind === "fidelity" && v2.approval ? (
            <FidelityPanel approval={v2.approval} productImageUrl={source.productImageUrl} gate={source.fidelity} jobId={v2.jobId} pending={pending}
              onApprove={(jobId, referenceId, specs) => run(() => handlers.approve(jobId, referenceId, specs))}
              onRegenerate={(jobId) => run(() => handlers.regenerate(jobId))} />
          ) : null}

          {view.kind === "awaiting_approval" || view.kind === "awaiting_planning_approval" ? (
            <ApprovalCard view={view} v2={v2} pending={pending} onAct={act} />
          ) : null}

          {view.kind === "scene_failed" || view.kind === "job_failed" || view.kind === "planning_failed" || view.kind === "blocked" ? (
            <ProblemCard view={view} pending={pending} onAct={act} advancedHref={advancedHref} />
          ) : null}

          <StatusCard view={view} />

          {message ? <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-inset ring-danger/25">{message}</p> : null}
        </div>
      </div>

      {view.scenes.length ? <div className="mt-10"><SceneTimeline scenes={view.scenes} /></div> : null}

      <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-5 text-caption text-fg-subtle">
        {v2.voice ? <span title={v2.voice.reason}>{v2.voice.label}</span> : null}
        {v2.avatar?.reason ? <span>{v2.avatar.reason}</span> : null}
        <a href={advancedHref} className={cx("font-medium text-fg-muted hover:text-fg", interactive, focusRing)}>Detalhes técnicos</a>
      </footer>
    </main>
  );
}

function StatusCard({ view }: { view: ReturnType<typeof withWorker> }) {
  const { status } = useShellStatusContext();
  return (
    <Card padding="none" className="p-5 sm:p-6" data-status-card>
      {view.kind === "queued" ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-warning ring-1 ring-inset ring-warning/25" data-worker-notice="offline">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />Worker offline · o projeto continua salvo na fila.
        </p>
      ) : null}
      {view.workerNotice === "unknown" ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-fg/[0.04] px-3.5 py-3 text-sm text-fg-muted ring-1 ring-inset ring-line" data-worker-notice="unknown">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />Status do worker não verificado.
        </p>
      ) : null}

      {view.context || view.sceneCounter ? (
        <div className="mb-4 space-y-1" data-context>
          {view.sceneCounter ? <p key={view.sceneCounter} className="animate-fade-in text-sm font-medium text-fg tabular">{view.sceneCounter}</p> : null}
          {view.context ? <p key={view.context} className="flex animate-fade-in items-center gap-2 text-sm text-fg-muted"><Spark active inherit className="text-primary-light" />{view.context}</p> : null}
        </div>
      ) : null}

      {view.sceneProgress && SCENE_PROGRESS_KINDS.has(view.kind) ? (
        <div className="mb-5">
          <Progress value={(view.sceneProgress.ready / view.sceneProgress.total) * 100} label="Cenas prontas" tone={view.tone === "danger" ? "danger" : view.tone === "warning" ? "warning" : "ai"} size="sm" />
          <p className="mt-1.5 text-caption text-fg-subtle tabular">{view.sceneProgress.ready} de {view.sceneProgress.total} cenas prontas</p>
        </div>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <StageStepper stages={view.stages} />
        <dl className="space-y-3 border-line text-sm sm:border-l sm:pl-5" data-summary>
          <div>
            <dt className="text-caption text-fg-subtle">Créditos</dt>
            <dd className="mt-0.5 font-medium text-fg tabular" data-credits={view.credits?.mode ?? "none"}>
              {view.credits ? creditsLabel(view.credits) : status ? "—" : <Skeleton className="mt-1 h-4 w-28" />}
            </dd>
          </div>
          {view.summary.map((row) => (
            <div key={row.label}><dt className="text-caption text-fg-subtle">{row.label}</dt><dd className="mt-0.5 truncate text-fg">{row.value}</dd></div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

function ApprovalCard({ view, v2, pending, onAct }: { view: GenerationView; v2: GenerationSource["v2"]; pending: boolean; onAct: () => void }) {
  const [showLines, setShowLines] = useState(false);
  const action = view.action!;
  const blockedReason = action.disabled && v2.headline !== "Tudo pronto para começar." && v2.headline !== "Roteiro pronto. Gere o vídeo quando quiser." ? v2.headline : null;
  return (
    <Card padding="none" className="p-5 sm:p-6" id="start" data-approval>
      <p className="text-sm text-fg-muted">{view.kind === "awaiting_planning_approval" ? "Nenhum custo acontece antes da sua aprovação. Esta aprovação cobre só o roteiro." : "Nenhuma cena é gerada antes da sua aprovação."}</p>
      {v2.estimate ? (
        <p className="mt-3 text-sm text-fg tabular">{v2.estimate.label}
          <button type="button" className={cx("ml-2 text-caption font-medium text-primary-light hover:text-fg", interactive, focusRing)} aria-expanded={showLines} onClick={() => setShowLines((v) => !v)}>Ver detalhes</button>
        </p>
      ) : null}
      {showLines && v2.estimate ? <ul className="mt-2 space-y-0.5 text-caption text-fg-muted tabular" aria-label="Detalhes da estimativa">{v2.estimate.lines.map((l) => <li key={l.label}>{l.label}: {l.value}</li>)}</ul> : null}
      {blockedReason ? <p className="mt-3 text-sm text-warning" role="status">{blockedReason}</p> : null}
      <Button variant="ai" size="lg" className="mt-5 w-full sm:w-auto" loading={pending} disabled={action.disabled} onClick={onAct} data-approve>
        {pending ? null : <Spark inherit />}{action.label}{action.credits !== null ? ` · ~${formatCredits(action.credits)} créditos` : ""}
      </Button>
    </Card>
  );
}

function ProblemCard({ view, pending, onAct, advancedHref }: { view: GenerationView; pending: boolean; onAct: () => void; advancedHref: string }) {
  const [open, setOpen] = useState(false);
  const blocked = view.kind === "blocked";
  return (
    <Card padding="none" className={cx("p-5 sm:p-6", blocked ? "border-warning/40" : "border-danger/30")} id="error" data-problem={view.kind}>
      <p className="flex items-start gap-2 text-sm text-fg-muted">
        {blocked ? <PauseCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> : null}
        {blocked ? "Verifique o estado nos detalhes técnicos antes de continuar. Nenhuma nova tentativa é feita sozinha." : view.action ? "Você pode tentar de novo; a nova tentativa usa uma cotação atualizada." : "Não há uma nova tentativa disponível agora. Veja os detalhes técnicos."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {view.action && !blocked ? (
          <Button loading={pending} disabled={view.action.disabled} onClick={onAct} data-retry={view.action.kind}>
            {view.action.label}{view.action.credits !== null ? ` · ~${formatCredits(view.action.credits)} créditos` : ""}
          </Button>
        ) : null}
        {view.details ? <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Ver detalhes</Button> : null}
        {blocked ? <a href={advancedHref} className={buttonClass({ variant: "secondary" })}>Detalhes técnicos</a> : null}
      </div>
      {open && view.details ? <p className="mt-4 rounded-xl bg-surface-sunken p-4 text-caption break-words text-fg-muted">{view.details}</p> : null}
    </Card>
  );
}
