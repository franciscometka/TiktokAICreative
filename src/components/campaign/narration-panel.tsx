"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptNarrationAction, regenerateNarrationAction } from "@/app/actions";
import type { BudgetDecisionPresentation } from "@/application/cost-presentation";
import type { NarrationView } from "@/application/narration-view";
import type { UserError } from "@/application/user-errors";
import { formatBrl } from "@/lib/money";
import { Badge, buttonClasses, Notice, Spinner } from "../ui/primitives";

const seconds = (n: number) => `${n.toFixed(1).replace(".", ",")}s`;

/**
 * Narração do criativo: voz, provider (MODO DE TESTE × Narração real · ElevenLabs), custo estimado
 * e real, status, encaixe na duração planejada e player. Regerar é sempre explícito, com o custo
 * mostrado antes, e cria uma NOVA versão.
 */
export function NarrationPanel({ jobId, narration }: { jobId: string | undefined; narration: NarrationView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<"regenerate" | "accept" | null>(null);
  const [decision, setDecision] = useState<BudgetDecisionPresentation | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const n = narration;

  const run = (action: () => Promise<{ ok: boolean; error?: UserError; value?: unknown }>) =>
    startTransition(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.error ?? null);
      const value = result.value as { kind?: string; decision?: BudgetDecisionPresentation } | undefined;
      setDecision(value?.kind === "budget_exceeded" && value.decision ? value.decision : null);
      setConfirm(null);
      router.refresh();
    });

  const regenerate = (authorizeOverBudget = false) =>
    jobId && run(() => regenerateNarrationAction({ jobId, authorizeOverBudget }));
  const accept = () => jobId && run(() => acceptNarrationAction(jobId));

  const fitText = n.fit
    ? n.fit.status === "fits"
      ? "Cabe na duração planejada."
      : n.fit.status === "too_short"
        ? `Fala ${seconds(-n.fit.difference)} mais curta que o planejado (sobra imagem no fim).`
        : `Fala ${seconds(n.fit.difference)} mais longa que o planejado.`
    : null;

  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Narração</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={n.isReal ? "blue" : "amber"}>{n.providerLabel}</Badge>
          <Badge tone={n.status === "ready" ? "green" : n.status === "failed" ? "red" : n.status === "review" ? "amber" : "neutral"} dot>
            {n.statusLabel}
          </Badge>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div className="col-span-2">
          <dt className="text-xs text-zinc-500">Voz</dt>
          <dd className="font-medium text-zinc-900">{n.speaker.name}</dd>
          <dd className="text-xs text-zinc-600">{n.speaker.description}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Custo estimado</dt>
          <dd className="font-medium tabular">{n.estimatedBrl === null ? "—" : formatBrl(n.estimatedBrl)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Custo real</dt>
          <dd className="font-medium tabular">
            {n.actualBrl === null ? "—" : formatBrl(n.actualBrl)}
            {n.actualSimulated && <span className="ml-1 text-xs font-normal text-zinc-500">(simulado)</span>}
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-xs text-zinc-500">Modelo</dt>
          <dd className="text-zinc-700">
            {n.model ?? "—"}
            {n.attempts > 1 && <span className="text-zinc-500"> · {n.attempts} tentativas (todas no custo real)</span>}
            {n.version && <span className="text-zinc-500"> · versão {n.version}</span>}
          </dd>
        </div>
      </dl>

      {(n.fit || n.captionTiming) && (
        <p className="mt-3 text-xs text-zinc-600">
          {n.fit && n.fit.measured && (
            <>
              Planejado {seconds(n.fit.targetDuration)} · fala real {seconds(n.fit.actualDuration)}. {fitText}{" "}
              {n.fit.extendSeconds > 0 && n.fit.action !== "review" && `O fim do vídeo ganha ${seconds(n.fit.extendSeconds)} (nenhuma fala é cortada). `}
            </>
          )}
          {n.captionTiming === "alignment" ? "Legendas sincronizadas com a fala real." : n.captionTiming === "estimated" ? "Legendas estimadas por cena." : null}
          {n.note && <span className="block text-amber-700">{n.note}</span>}
        </p>
      )}

      {n.audioUrl && (
        <audio controls preload="metadata" src={n.audioUrl} className="mt-3 w-full" />
      )}

      {n.lastError && n.status !== "pending" && (
        <div className="mt-3">
          <Notice tone="red" title="A última geração da narração falhou">
            {n.lastError} Nada foi re-tentado automaticamente.
          </Notice>
        </div>
      )}

      {n.status === "review" && n.fit && confirm === null && (
        <div className="mt-3">
          <Notice tone="amber" title="A narração ficou bem mais longa que o planejado">
            Fala real de {seconds(n.fit.actualDuration)} para {seconds(n.fit.targetDuration)} planejados. Escolha: aceitar um vídeo
            de ~{seconds(n.fit.targetDuration + n.fit.extendSeconds)} (sem custo), gerar a narração de novo (nova cobrança) ou
            cancelar o criativo.
          </Notice>
        </div>
      )}

      {decision && (
        <div className="mt-3">
          <Notice
            tone="amber"
            title="Orçamento excedido"
            action={
              decision.canAuthorize ? (
                <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => regenerate(true)} disabled={pending}>
                  Autorizar até {formatBrl(decision.authorizeUpToBrl)}
                </button>
              ) : undefined
            }
          >
            Gerar a narração de novo levaria o total a {formatBrl(decision.projectedBrl)} (limite {formatBrl(decision.limitBrl)}). Nada foi
            gerado.
          </Notice>
        </div>
      )}

      {confirm === "regenerate" && (
        <div className="mt-3">
          <Notice
            tone="amber"
            title="Gerar a narração de novo?"
            action={
              <div className="flex gap-2">
                <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirm(null)} disabled={pending}>
                  Voltar
                </button>
                <button type="button" className={buttonClasses("primary", "sm")} onClick={() => regenerate(false)} disabled={pending}>
                  {pending && <Spinner />}
                  Gerar narração
                </button>
              </div>
            }
          >
            {n.isReal
              ? `Nova chamada à ElevenLabs: ~${n.regenerateEstimateBrl === null ? "—" : formatBrl(n.regenerateEstimateBrl)}. A versão atual continua no custo e no histórico.`
              : "Narração simulada (sem custo real). Cria uma nova versão e renderiza de novo."}
          </Notice>
        </div>
      )}

      {confirm === "accept" && n.fit && (
        <div className="mt-3">
          <Notice
            tone="amber"
            title="Aceitar vídeo mais longo?"
            action={
              <div className="flex gap-2">
                <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirm(null)} disabled={pending}>
                  Voltar
                </button>
                <button type="button" className={buttonClasses("primary", "sm")} onClick={accept} disabled={pending}>
                  {pending && <Spinner />}
                  Aceitar e renderizar
                </button>
              </div>
            }
          >
            O vídeo final passa a ter ~{seconds(n.fit.targetDuration + n.fit.extendSeconds)}. Nenhuma chamada paga.
          </Notice>
        </div>
      )}

      {confirm === null && (n.canAccept || n.canRegenerate) && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {n.canRegenerate && (
            <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirm("regenerate")} disabled={pending}>
              Gerar narração novamente
            </button>
          )}
          {n.canAccept && (
            <button type="button" className={buttonClasses("primary", "sm")} onClick={() => setConfirm("accept")} disabled={pending}>
              Aceitar duração
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="red" title={error.title}>
            {error.message}
          </Notice>
        </div>
      )}
    </div>
  );
}
