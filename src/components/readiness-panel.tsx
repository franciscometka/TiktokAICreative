import type { RuntimeReadiness } from "@/domain/readiness";
import { Badge, Notice, Panel } from "./ui/primitives";

export function ReadinessPanel({ readiness, compact = false }: { readiness: RuntimeReadiness; compact?: boolean }) {
  return <Panel className="p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Diagnóstico de prontidão</h2><p className="mt-1 text-sm text-zinc-600">Leitura local; nenhuma credencial é exibida e nenhum provider é consultado.</p></div>
      <Badge tone={readiness.readyForControlledRealValidation ? "green" : "amber"}>{readiness.readyForControlledRealValidation ? "Pronto para validação controlada" : "Preparação necessária"}</Badge>
    </div>
    {readiness.blocking ? <div className="mt-4"><Notice tone="amber" title="Fluxo bloqueado">{readiness.blocking}</Notice></div> : null}
    <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{readiness.flow.map(group => <li key={group.id} className="rounded border border-zinc-200 p-3 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-semibold">{group.label}</span><Badge tone={group.ready ? "green" : "amber"}>{group.ready ? "Pronto" : "Bloqueado"}</Badge></div><ul className="mt-2 space-y-1 text-xs text-zinc-600">{group.checks.map(check => <li key={check.id}>{check.ok ? "✓" : "✗"} {check.label}: {check.detail}</li>)}</ul></li>)}</ul>
    {readiness.issues.length > 0 ? <div className="mt-4 space-y-2">{readiness.issues.map(issue => <Notice key={issue.variable} tone="red" title={`${issue.variable} inválida`}>{issue.message}</Notice>)}</div> : null}
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{readiness.items.map(item => <div key={item.id} className="rounded border border-zinc-200 p-3"><div className="flex items-center justify-between gap-2"><dt className="text-sm font-semibold">{item.label}</dt><Badge tone={item.configured ? "green" : "amber"}>{item.configured ? "Configurado" : "Pendente"}</Badge></div><dd className="mt-2 text-xs text-zinc-600"><span className="font-medium text-zinc-800">Selecionado: {item.selected}</span><span className="mt-1 block">{item.detail}</span></dd></div>)}</dl>
    {!compact ? <details className="mt-4 rounded bg-zinc-50 p-3"><summary className="cursor-pointer text-sm font-medium">Dependências entre etapas</summary><ol className="mt-3 space-y-2 text-sm text-zinc-600">{readiness.dependencies.map((dependency, index) => <li key={dependency.stage}><span className="font-medium text-zinc-900">{index + 1}. {dependency.label}:</span> {dependency.detail}</li>)}</ol></details> : null}
  </Panel>;
}
