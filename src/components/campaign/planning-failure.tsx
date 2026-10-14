"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { retryPlanningAction } from "@/app/actions";
import type { UserError } from "@/application/user-errors";
import { buttonClasses, Notice, Panel, Spinner } from "../ui/primitives";

/** Falha ou interrupção do planejamento. Planejar de novo é sempre uma ação confirmada. */
export function PlanningFailure({
  campaignId,
  error,
  detail,
  simulated,
  planningAvailable,
}: {
  campaignId: string;
  error: UserError;
  detail: string | undefined;
  simulated: boolean;
  planningAvailable: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<UserError | null>(null);
  const [pending, startTransition] = useTransition();
  const interrupted = error.code === "interrupted";

  function retry() {
    setActionError(null);
    startTransition(async () => {
      const result = await retryPlanningAction(campaignId);
      if (result.ok) router.refresh();
      else setActionError(result.error);
      setConfirming(false);
    });
  }

  return (
    <Panel className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${interrupted ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700"}`}
          aria-hidden
        >
          !
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{error.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">{error.message}</p>
          {detail && (
            <details className="mt-3 text-xs text-zinc-500">
              <summary className="cursor-pointer select-none hover:text-zinc-700">Detalhes técnicos</summary>
              <p className="mt-2 rounded-md bg-zinc-50 p-3 font-mono break-words whitespace-pre-wrap text-zinc-600">{detail}</p>
            </details>
          )}
        </div>
      </div>

      {confirming ? (
        <div className="mt-5">
          <Notice
            tone="amber"
            title="Confirmar novo planejamento"
            action={
              <div className="flex gap-2">
                <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirming(false)} disabled={pending}>
                  Voltar
                </button>
                <button type="button" className={buttonClasses("primary", "sm")} onClick={retry} disabled={pending}>
                  {pending && <Spinner />}
                  Planejar novamente
                </button>
              </div>
            }
          >
            {simulated
              ? "Será feita uma nova execução do planejamento simulado (sem custo)."
              : "Será feita uma NOVA chamada ao Claude, com novo custo. O custo das tentativas anteriores continua contabilizado."}
          </Notice>
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          {error.retryable && (
            <button type="button" className={buttonClasses("primary", "md")} onClick={() => setConfirming(true)} disabled={!planningAvailable}>
              Planejar novamente
            </button>
          )}
          <Link href={`/create?from=${campaignId}`} className={buttonClasses("secondary", "md")}>
            Editar dados e criar nova campanha
          </Link>
        </div>
      )}
      {!planningAvailable && (
        <p className="mt-3 text-xs text-red-600">O planejamento está indisponível: ANTHROPIC_API_KEY não configurada no servidor.</p>
      )}
      {actionError && (
        <div className="mt-4">
          <Notice tone="red" title={actionError.title}>
            {actionError.message}
          </Notice>
        </div>
      )}
    </Panel>
  );
}
