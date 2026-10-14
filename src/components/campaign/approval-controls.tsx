"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveCreativeAction, cancelCreativeAction, resolveBudgetAction } from "@/app/actions";
import type { ActionResult, GenerationResultView } from "@/application/campaign-actions";
import type { BudgetDecisionPresentation } from "@/application/cost-presentation";
import type { UserError } from "@/application/user-errors";
import { formatBrl } from "@/lib/money";
import { buttonClasses, Notice, Spinner } from "../ui/primitives";
import { BudgetDialog } from "./budget-dialog";

type Decision = { source: "approval" | "generation"; decision: BudgetDecisionPresentation };

/**
 * Aprovar (gerar) ou cancelar UM criativo. A aprovação envia o estimateId exibido; se o
 * servidor tiver outra estimativa, a ação é recusada (StaleEstimateError).
 */
export function ApprovalControls({
  jobId,
  estimateId,
  futureTotalBrl,
  canApprove,
  canCancel,
  mediaIsMock,
  audioIsReal,
  rendererIsReal,
  pendingDecision,
}: {
  jobId: string;
  estimateId: string;
  futureTotalBrl: number;
  canApprove: boolean;
  canCancel: boolean;
  mediaIsMock: boolean;
  /** Narração real (ElevenLabs): é cobrada; vídeo IA continua em modo de teste. */
  audioIsReal: boolean;
  rendererIsReal: boolean;
  pendingDecision: Decision | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<Decision | undefined>(undefined);
  const [error, setError] = useState<UserError | string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const activeDecision = decision ?? pendingDecision;
  const [dialogOpen, setDialogOpen] = useState(false);

  function handle(result: ActionResult<GenerationResultView>) {
    if (!result.ok) {
      setError(result.error);
      router.refresh();
      return;
    }
    const outcome = result.value;
    if (outcome.kind === "budget_exceeded") {
      setDecision({ source: outcome.source, decision: outcome.decision });
      setDialogOpen(true);
    } else {
      setDialogOpen(false);
      setDecision(undefined);
      if (outcome.kind === "failed") setError(outcome.message);
    }
    router.refresh();
  }

  const approve = (authorizeOverBudget = false) =>
    startTransition(async () => {
      setError(null);
      handle(await approveCreativeAction({ jobId, estimateId, authorizeOverBudget }));
    });

  const resolve = (choice: "cancel" | "authorize") =>
    startTransition(async () => {
      setError(null);
      handle(await resolveBudgetAction({ jobId, choice }));
    });

  const cancel = () =>
    startTransition(async () => {
      setError(null);
      const result = await cancelCreativeAction(jobId);
      if (!result.ok) setError(result.error);
      setConfirmCancel(false);
      router.refresh();
    });

  const showControls = canApprove || pendingDecision?.source === "generation";

  return (
    <div className="space-y-3">
      {audioIsReal && showControls && (
        <Notice tone="blue" title="Narração real · ElevenLabs">
          Ao aprovar, a narração é gerada de verdade (uma chamada, cobrada pelo valor estimado acima). O vídeo IA continua em MODO DE
          TESTE: as cenas de IA aparecem como placeholder marcado.
        </Notice>
      )}

      {mediaIsMock && showControls && (
        <Notice tone="amber" title="MODO DE TESTE — nenhuma mídia de IA real será gerada ou cobrada.">
          {rendererIsReal
            ? "Vídeo IA e narração usam providers simulados. O MP4 final é renderizado de verdade, nesta máquina (sem custo de API): cenas de IA aparecem como placeholder marcado e o vídeo sai sem som."
            : "Vídeo e áudio usam providers simulados e RENDERER=mock: a aprovação valida o fluxo, mas nenhum MP4 é produzido."}
        </Notice>
      )}

      {pendingDecision && !dialogOpen && (
        <Notice
          tone="amber"
          title="Orçamento excedido"
          action={
            <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setDialogOpen(true)}>
              Revisar decisão
            </button>
          }
        >
          Projetado {formatBrl(pendingDecision.decision.projectedBrl)} para um limite de {formatBrl(pendingDecision.decision.limitBrl)}.
        </Notice>
      )}

      {confirmCancel ? (
        <Notice
          tone="red"
          title="Cancelar este criativo?"
          action={
            <div className="flex gap-2">
              <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirmCancel(false)} disabled={pending}>
                Voltar
              </button>
              <button type="button" className={buttonClasses("danger", "sm")} onClick={cancel} disabled={pending}>
                {pending && <Spinner />}
                Cancelar criativo
              </button>
            </div>
          }
        >
          Nada será gerado para ele. O custo do planejamento já utilizado não volta.
        </Notice>
      ) : (
        showControls && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {canCancel && (
              <button type="button" className={buttonClasses("secondary", "lg")} onClick={() => setConfirmCancel(true)} disabled={pending}>
                Cancelar
              </button>
            )}
            {canApprove && (
              <button type="button" className={buttonClasses("primary", "lg")} onClick={() => approve(false)} disabled={pending}>
                {pending && <Spinner />}
                {pending ? "Processando…" : `Gerar por aproximadamente ${formatBrl(futureTotalBrl)}`}
              </button>
            )}
          </div>
        )
      )}

      {error && (
        <Notice tone="red" title={typeof error === "string" ? "A geração falhou" : error.title}>
          {typeof error === "string" ? error : error.message}
        </Notice>
      )}

      <BudgetDialog
        open={dialogOpen}
        decision={activeDecision?.decision}
        source={activeDecision?.source ?? "approval"}
        pending={pending}
        onClose={() => setDialogOpen(false)}
        onCancel={() => {
          if (activeDecision?.source === "generation") resolve("cancel");
          else setDialogOpen(false);
        }}
        onAuthorize={() => {
          if (activeDecision?.source === "generation") resolve("authorize");
          else approve(true);
        }}
      />
    </div>
  );
}
