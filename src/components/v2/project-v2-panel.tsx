"use client";

import { useState, useTransition } from "react";
import type { ProgressStep, ProjectV2View } from "@/application/project-v2-view";
import type { ChangeRequest } from "@/domain/change-request";
import { cx, Spinner } from "../ui/primitives";
import { Card, v2Button, v2Input } from "./ui";

/**
 * Projeto na UX V2 (Lote 6): UMA coisa por vez — progresso, aprovação simples, erro curto ou o
 * vídeo pronto. Presentacional: as ações de servidor são injetadas (testável sem Next).
 */

type Outcome = { ok: boolean; error?: { message: string } };
export interface ProjectV2Handlers {
  startPlanning: (token: string) => Promise<Outcome>;
  authorize: (jobId: string, token: string) => Promise<Outcome>;
  /** `confirmedSpecs`: especificações exatas (ex.: 2100W) conferidas uma a uma no checklist. */
  approve: (jobId: string, referenceId: string, confirmedSpecs: string[]) => Promise<Outcome>;
  regenerate: (jobId: string) => Promise<Outcome>;
  retryScene: (jobId: string, sceneId: string, token: string) => Promise<Outcome>;
  retryPlanning: () => Promise<Outcome>;
  estimateChange: (text: string) => Promise<{ ok: true; value: ChangeRequest } | { ok: false; error: { message: string } }>;
  refresh: () => void;
}

const ICON: Record<ProgressStep["state"], string> = { done: "✓", current: "●", pending: "○", error: "!" };

export function ProgressCard({ steps, title = "Gerando seu vídeo" }: { steps: ProgressStep[]; title?: string }) {
  const done = steps.filter((s) => s.state === "done").length;
  const current = steps.some((s) => s.state === "current");
  return (
    <Card className="p-6 sm:p-8" id="progress">
      <h2 className="text-xl font-semibold tracking-tight text-zinc-950">{title}</h2>
      <ol className="mt-5 space-y-3" aria-label="Progresso">
        {steps.map((step) => (
          <li key={step.id} data-state={step.state} className={cx("flex items-center gap-3 text-[15px]", step.state === "pending" ? "text-zinc-400" : step.state === "error" ? "text-red-700" : "text-zinc-900")}>
            <span aria-hidden className={cx("grid size-6 place-items-center rounded-full text-xs font-semibold", step.state === "done" && "bg-emerald-50 text-emerald-700", step.state === "current" && "bg-indigo-50 text-indigo-600", step.state === "pending" && "bg-zinc-100", step.state === "error" && "bg-red-50")}>{ICON[step.state]}</span>
            {step.label}
          </li>
        ))}
      </ol>
      <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
        <div className="relative h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${Math.max(6, (done / steps.length) * 100)}%` }}>
          {current && <span className="progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-white/40" />}
        </div>
      </div>
      {current && <p className="mt-3 text-sm text-zinc-500">Pode levar alguns minutos.</p>}
    </Card>
  );
}

export function ResultCard({ result, campaignId, onEstimate }: { result: NonNullable<ProjectV2View["result"]>; campaignId: string; onEstimate: ProjectV2Handlers["estimateChange"] }) {
  const [text, setText] = useState("");
  const [change, setChange] = useState<ChangeRequest | null>(null);
  const [message, setMessage] = useState<string>();
  const [pending, startTransition] = useTransition();
  const update = () => startTransition(async () => {
    const r = await onEstimate(text);
    if (r.ok) { setChange(r.value); setMessage(undefined); } else { setChange(null); setMessage(r.error.message); }
  });
  return (
    <Card className="overflow-hidden p-0" id="result">
      <div className="grid gap-0 md:grid-cols-[minmax(0,22rem)_1fr]">
        <div className="bg-zinc-950 p-4 sm:p-6"><video className="mx-auto aspect-[9/16] w-full max-w-[22rem] rounded-xl bg-black object-contain" controls src={result.videoUrl} /></div>
        <div className="p-6 sm:p-8">
          <h2 className="text-[26px] font-semibold tracking-tight text-zinc-950">Seu vídeo está pronto</h2>
          <p className="mt-2 text-[15px] text-zinc-500 tabular"><span>{result.durationLabel}</span> · <span>{result.costLabel}</span></p>
          <div className="mt-6 flex flex-wrap gap-2">
            <a className={v2Button("primary", "lg")} href={result.downloadUrl}>Baixar vídeo</a>
            <a className={v2Button("secondary", "lg")} href={`/create?from=${encodeURIComponent(campaignId)}`}>Gerar outra versão</a>
          </div>
          <div className="mt-8 border-t border-zinc-100 pt-6">
            <label htmlFor="change-request" className="text-sm font-medium text-zinc-900">Quer mudar alguma coisa?</label>
            <textarea id="change-request" rows={3} maxLength={500} className={cx(v2Input(), "mt-2 resize-none")} placeholder="Deixe a fala mais natural..." value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" className={cx(v2Button("secondary"), "mt-3")} disabled={pending || !text.trim()} onClick={update}>{pending && <Spinner />}Atualizar vídeo</button>
            {message && <p className="mt-3 text-sm text-red-700" role="alert">{message}</p>}
            {change && (
              <div className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm" aria-live="polite">
                <p className="font-medium text-zinc-900 tabular">{change.estimatedCost.label}</p>
                <p className="mt-1 text-zinc-600">Nada foi cobrado. {change.executable ? "Confirme para atualizar." : "A atualização automática deste tipo de pedido ainda não está disponível: crie uma nova versão com o ajuste."}</p>
                {!change.executable && <a className={cx(v2Button("ghost", "sm"), "mt-2")} href={`/create?from=${encodeURIComponent(campaignId)}`}>Criar nova versão com ajuste</a>}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function ProjectV2Panel({ view, campaignId, handlers, advancedHref }: { view: ProjectV2View; campaignId: string; handlers: ProjectV2Handlers; advancedHref: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>();
  const [checks, setChecks] = useState<boolean[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const run = (action: () => Promise<Outcome>) => startTransition(async () => {
    const r = await action();
    setMessage(r.ok ? undefined : r.error?.message ?? "Não foi possível continuar.");
    handlers.refresh();
  });
  const allChecked = view.approval ? view.approval.checklist.every((_, i) => checks[i]) : false;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[28px] font-semibold tracking-tight text-zinc-950 sm:text-[32px]">{view.title}</h1>
        {view.avatar && <p className="mt-1 text-sm text-zinc-500">{view.avatar.label}</p>}
      </header>

      {view.result ? <ResultCard result={view.result} campaignId={campaignId} onEstimate={handlers.estimateChange} /> : null}

      {view.approval ? (
        <Card className="overflow-hidden p-0" id="approval">
          <div className="grid md:grid-cols-[minmax(0,18rem)_1fr]">
            <div className="bg-zinc-100">
              {view.approval.avatarPhotoUrl && (
                <figure className="flex items-center gap-3 border-b border-zinc-200 bg-white p-3" data-testid="avatar-photo">
                  {/* eslint-disable-next-line @next/next/no-img-element -- foto do avatar servida por rota com IDs */}
                  <img src={view.approval.avatarPhotoUrl} alt={`Foto do avatar ${view.approval.avatarName ?? ""}`.trim()} className="size-14 rounded-lg object-cover" />
                  <figcaption className="text-sm text-zinc-600">Foto de {view.approval.avatarName ?? "seu avatar"}<br /><span className="text-xs text-zinc-400">a pessoa abaixo deve ser a mesma</span></figcaption>
                </figure>
              )}
              <div className="aspect-[9/16]">
                {view.approval.imageUrl
                  // eslint-disable-next-line @next/next/no-img-element -- imagem local servida por rota com IDs
                  ? <img src={view.approval.imageUrl} alt={view.approval.avatarName ? `${view.approval.avatarName} com o produto` : "Apresentadora com o produto"} className="size-full object-cover" />
                  : <div className="grid size-full place-items-center text-sm text-zinc-400">Imagem indisponível</div>}
              </div>
            </div>
            <div className="p-6 sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-zinc-950">{view.approval.title}</h2>
              {view.approval.simulated && <p className="mt-1 text-xs text-amber-700">Simulação: a imagem é a foto do produto.</p>}
              <ul className="mt-5 space-y-3">
                {view.approval.checklist.map((item, i) => (
                  <li key={item}><label className="flex items-center gap-3 text-[15px] text-zinc-800">
                    <input type="checkbox" className="size-5 rounded accent-indigo-600" checked={!!checks[i]} onChange={(e) => setChecks((c) => { const n = [...c]; n[i] = e.target.checked; return n; })} />{item}
                  </label></li>
                ))}
              </ul>
              <div className="mt-6 flex flex-wrap gap-2">
                <button type="button" className={v2Button("primary", "lg")} disabled={pending || !allChecked || !view.jobId} onClick={() => run(() => handlers.approve(view.jobId!, view.approval!.referenceId, view.approval!.specs))}>
                  {pending && <Spinner />}{view.approval.kind === "presenter" ? "Usar esta pessoa" : "Confirmar"}
                </button>
                {view.approval.canGenerateOther && <button type="button" className={v2Button("secondary", "lg")} disabled={pending || !view.jobId} onClick={() => run(() => handlers.regenerate(view.jobId!))}>Gerar outra</button>}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {view.error ? (
        <Card className="p-6 sm:p-8" id="error">
          <h2 className="text-xl font-semibold text-zinc-950">{view.error.message}</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={v2Button("primary")} disabled={pending} onClick={() => run(() => {
              const e = view.error!;
              if (e.retry === "planning") return handlers.retryPlanning();
              if (e.retry === "scene" && e.sceneId && e.sceneToken && view.jobId) return handlers.retryScene(view.jobId, e.sceneId, e.sceneToken);
              return view.jobId && view.quoteToken ? handlers.authorize(view.jobId, view.quoteToken) : Promise.resolve({ ok: false, error: { message: "Abra os detalhes técnicos para continuar." } });
            })}>{pending && <Spinner />}Tentar novamente</button>
            <button type="button" className={v2Button("ghost")} aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>Ver detalhes</button>
          </div>
          {showDetails && <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm break-words text-zinc-600">{view.error.details}</p>}
        </Card>
      ) : null}

      {(view.phase === "ready_to_generate" || view.phase === "planning_approval") ? (
        <Card className="p-6 sm:p-8" id="start">
          <h2 className="text-xl font-semibold text-zinc-950">{view.headline}</h2>
          {view.estimate && <p className="mt-2 text-[15px] text-zinc-600 tabular">{view.estimate.label} <button type="button" className="ml-2 text-sm font-medium text-indigo-600" aria-expanded={showCost} onClick={() => setShowCost((v) => !v)}>Ver detalhes</button></p>}
          {showCost && view.estimate && <ul className="mt-2 space-y-0.5 text-sm text-zinc-500 tabular">{view.estimate.lines.map((l) => <li key={l.label}>{l.label}: {l.value}</li>)}</ul>}
          <button type="button" className={cx(v2Button("primary", "lg"), "mt-5")} disabled={pending || !view.quoteToken || (view.phase === "ready_to_generate" && !view.jobId)}
            onClick={() => run(() => view.phase === "planning_approval" ? handlers.startPlanning(view.quoteToken!) : handlers.authorize(view.jobId!, view.quoteToken!))}>
            {pending && <Spinner />}Gerar vídeo
          </button>
        </Card>
      ) : null}

      {view.phase !== "done" ? <ProgressCard steps={view.progress} title={view.phase === "failed" || view.phase === "planning_failed" ? "Progresso" : "Gerando seu vídeo"} /> : null}
      {view.phase === "simulated_done" && <p className="text-sm text-zinc-500">{view.headline}</p>}
      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
        {view.voice && <span title={view.voice.reason}>{view.voice.label}</span>}
        {view.avatar?.reason && <span>{view.avatar.reason}</span>}
        <a href={advancedHref} className="font-medium text-zinc-500 hover:text-zinc-900">Detalhes técnicos</a>
      </footer>
    </div>
  );
}
