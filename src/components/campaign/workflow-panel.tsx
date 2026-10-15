import Link from "next/link";
import type { CreativeView } from "@/application/campaign-view";
import { formatBrl } from "@/lib/money";
import { Badge, buttonClasses, Panel } from "../ui/primitives";
const labels = { ready: "Concluído", running: "Em andamento", waiting: "Aguardando", paused: "Pausado", failed: "Falhou", skipped: "Não se aplica" } as const;
export function WorkflowPanel({ creative }: { creative: CreativeView }) {
  return <Panel className="scroll-mt-24 p-5 sm:p-6" id={`job-${creative.jobId}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Job {String(creative.number).padStart(2, "0")}</p>
        <h2 className="mt-1 text-lg font-semibold">{creative.concept.title.replace(/^\[MOCK\] /, "")}</h2>
        <p className="mt-1 break-all text-xs text-zinc-500">{creative.jobId} · {creative.jobStatusLabel}</p></div>
      <Badge tone={creative.offline ? "blue" : "neutral"}>{creative.offline ? "Offline · gasto real R$ 0,00" : "Histórico"}</Badge>
    </div>
    <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm"><div><dt className="text-zinc-500">Duração planejada</dt><dd className="font-medium">≈ {creative.durationSeconds.toFixed(1)}s</dd></div>
      <div><dt className="text-zinc-500">Custo de referência antes de simular</dt><dd className="font-medium">{creative.estimate ? formatBrl(creative.estimate.futureTotalBrl) : "Calculando"}</dd></div></dl>
    <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Etapas do pipeline">
      {(creative.workflow ?? []).map((step, i) => <li key={step.id} className="rounded border border-zinc-200 p-3" aria-current={step.state === "running" ? "step" : undefined}>
        <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{i + 1}. {step.label}</span><Badge tone={step.state === "failed" ? "red" : step.state === "running" ? "blue" : step.state === "paused" ? "amber" : "neutral"}>{labels[step.state]}</Badge></div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">{step.detail}</p>{step.simulated && step.state === "ready" ? <p className="mt-1 text-xs font-medium text-blue-700">Simulado</p> : null}
      </li>)}
    </ol>
    <details className="mt-4 rounded bg-zinc-50 p-3"><summary className="cursor-pointer text-sm font-medium">Narração associada ao job · texto do roteiro</summary><p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{creative.script}</p></details>
    <div className="mt-4 flex flex-wrap gap-2"><Link className={buttonClasses("secondary", "sm")} href={`#criativo-${creative.number}`}>Ver cenas e avatar</Link>
      <Link className={buttonClasses("primary", "sm")} href={`#custo-${creative.number}`}>{creative.interrupted ? "Retomar de onde parou" : creative.canApprove ? "Revisar estimativa e simular" : "Ver resultado e versões"}</Link></div>
  </Panel>;
}
