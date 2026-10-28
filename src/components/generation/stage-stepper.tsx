import type { GenerationView, StageState } from "@/application/generation-view";
import { cx, Spark } from "../ds";

/**
 * L8.5 — etapas REAIS da geração (lista ordenada semântica). O estado de cada etapa é texto
 * acessível; o ícone muda só quando o estado muda (key por estado → a animação não reinicia a
 * cada poll).
 */

const STATE_LABEL: Record<StageState, string> = { completed: "concluída", active: "em andamento", upcoming: "a seguir", failed: "com problema", attention: "aguardando você" };

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" className="animate-draw" />
    </svg>
  );
}

function Marker({ state }: { state: StageState }) {
  return (
    <span key={state} className={cx("relative grid size-6 shrink-0 animate-fade-in place-items-center rounded-full text-[11px] font-semibold ring-1 ring-inset",
      state === "completed" && "bg-success-soft text-success ring-success/30",
      state === "active" && "bg-primary-soft text-primary-light ring-primary/40",
      state === "upcoming" && "bg-fg/[0.04] text-fg-subtle ring-line",
      state === "failed" && "bg-danger-soft text-danger ring-danger/30",
      state === "attention" && "bg-warning-soft text-warning ring-warning/30")}>
      {state === "completed" ? <CheckIcon className="size-3.5" />
        : state === "active" ? <Spark active inherit className="text-[11px]" />
        : state === "failed" || state === "attention" ? "!" : <span className="size-1.5 rounded-full bg-current" />}
    </span>
  );
}

export function StageStepper({ stages }: { stages: GenerationView["stages"] }) {
  return (
    <ol aria-label="Etapas da geração" className="space-y-0.5" data-stages>
      {stages.map((stage, i) => (
        <li key={stage.id} data-stage={stage.id} data-state={stage.state} aria-current={stage.state === "active" || stage.state === "attention" ? "step" : undefined}
          className="relative flex items-center gap-3 py-1.5">
          {i < stages.length - 1 ? <span aria-hidden className={cx("absolute top-8 left-3 h-[calc(100%-1.25rem)] w-px -translate-x-1/2", stage.state === "completed" ? "bg-success/40" : "bg-line")} /> : null}
          <Marker state={stage.state} />
          <span className={cx("text-sm", stage.state === "upcoming" ? "text-fg-subtle" : stage.state === "failed" ? "font-medium text-danger" : stage.state === "attention" ? "font-medium text-warning" : stage.state === "active" ? "font-medium text-fg" : "text-fg-muted")}>
            {stage.label}
          </span>
          <span className="sr-only">: {STATE_LABEL[stage.state]}</span>
        </li>
      ))}
    </ol>
  );
}
