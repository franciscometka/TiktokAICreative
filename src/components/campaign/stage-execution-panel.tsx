"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { configureStageAction, executeStageAction, executePlanningStageAction } from "@/app/actions";
import type { StageCapabilities, StageQuote, ExecutionMode } from "@/domain/execution";
import { formatBrl } from "@/lib/money";
import { buttonClasses, Panel, Badge } from "../ui/primitives";
export const STAGE_LABELS = { planning: "Roteiro e planejamento", narration: "Narração", scenes: "Cenas de vídeo", avatar: "Presenter / avatar", render: "Render final" };
export function StageExecutionPanel({ jobId, campaignId, quotes, capabilities }: { jobId?: string; campaignId: string; quotes: StageQuote[]; capabilities: StageCapabilities }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const run = (action: () => Promise<{ ok: boolean; error?: { message: string } }>) => startTransition(async () => {
    try { const result = await action(); setMessage(result.ok ? "Solicitação processada. Confira o estado e eventuais limites restantes abaixo. Nenhuma outra chamada paga foi autorizada." : result.error?.message ?? "Não foi possível executar."); }
    catch { setMessage("Não foi possível concluir a ação. Reabra o job antes de tentar novamente."); }
    setConfirm(null); router.refresh();
  });
  return <Panel className="p-5 sm:p-6"><h2 className="text-lg font-semibold">Execução por etapa</h2><p className="mt-2 text-sm text-zinc-600">MOCK é o padrão. Cada execução REAL exige revisão e aprovação separada; vídeo pago gera uma cena por clique. Trocar o modo preserva as versões anteriores.</p>
    <div className="mt-4 space-y-4">{quotes.map(q => { const action = q.repeat ?? q; return <section key={q.stage} className="rounded-md border border-zinc-200 p-4" aria-label={STAGE_LABELS[q.stage]}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{STAGE_LABELS[q.stage]}</h3><Badge>{q.state}</Badge></div>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><label>Modo de {STAGE_LABELS[q.stage]}<select aria-label={`Modo de ${STAGE_LABELS[q.stage]}`} className="mt-1 block w-full rounded border border-zinc-300 p-2" value={q.mode} disabled={pending || q.stage === "planning" || !jobId} onChange={e => run(() => configureStageAction({ jobId, stage: q.stage, mode: e.target.value as ExecutionMode }))}><option value="mock">MOCK</option><option value="real" disabled={!capabilities[q.stage].available}>REAL</option></select></label>
        <div><p className="text-zinc-500">Provider / modelo</p><p className="mt-1 break-all">{q.provider} · {q.model}</p></div><div><p className="text-zinc-500">Estimativa desta ação</p><p className="mt-1 font-semibold">{formatBrl(q.estimatedBrl)}{q.mode === "mock" ? " · sem cobrança" : q.stage === "render" ? " · local" : " · estimado"}</p><p className="mt-1 text-xs">Gasto real: {formatBrl(q.actualBrl)} · simulado registrado: {formatBrl(q.simulatedBrl)}</p></div></div>
      {!capabilities[q.stage].available ? <p className="mt-2 text-xs text-zinc-500">REAL indisponível: {capabilities[q.stage].reason}</p> : null}
      {q.blocked ? <p className="mt-2 text-sm text-amber-800">{q.blocked}</p> : null}
      {(action.ready || action.budgetDecision?.canAuthorizeOverBudget) ? <div className="mt-3">{confirm === action.token ? <div className="rounded bg-amber-50 p-3"><p className="mb-3 text-sm">Aprovar {STAGE_LABELS[q.stage]} em {q.mode.toUpperCase()} por aproximadamente {formatBrl(action.estimatedBrl)}? {q.stage === "scenes" || q.stage === "avatar" ? `Unidade: ${q.unit}.` : ""} Nenhuma outra etapa paga está autorizada. {action.budgetDecision ? `Excedente solicitado: autorizar até R$ ${action.budgetDecision.newEstimatedTotalBrl.toFixed(2)} (limite original R$ ${action.budgetDecision.budgetBrl.toFixed(2)}).` : ""}</p><button disabled={pending} className={buttonClasses()} onClick={() => run(() => q.stage === "planning" ? executePlanningStageAction({ campaignId, token: action.token, regenerate: action.regenerate, authorizeOverBudget: !!action.budgetDecision }) : executeStageAction({ jobId, stage: q.stage, token: action.token, regenerate: action.regenerate, authorizeOverBudget: !!action.budgetDecision }))}>Confirmar e executar {q.mode.toUpperCase()}</button><button className={buttonClasses("secondary")} disabled={pending} onClick={() => setConfirm(null)}>Voltar</button></div> : <button className={buttonClasses(q.mode === "real" ? "primary" : "secondary", "sm")} disabled={pending} onClick={() => setConfirm(action.token)}>{q.done ? `Nova versão ${q.mode.toUpperCase()} · estimativa ${formatBrl(action.estimatedBrl)}` : q.mode === "real" ? "Revisar e executar REAL" : "Executar MOCK"}</button>}</div> : null}
    </section>; })}</div>{message ? <p className="mt-4 text-sm" role="status">{message}</p> : null}
  </Panel>;
}
