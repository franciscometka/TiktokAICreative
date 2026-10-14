"use client";

import type { BudgetDecisionPresentation } from "@/application/cost-presentation";
import { formatBrl } from "@/lib/money";
import { Dialog } from "../ui/dialog";
import { buttonClasses, Spinner } from "../ui/primitives";

/**
 * Orçamento excedido. Os números e a permissão de autorizar vêm do domínio (BUDGET_EXCEEDED);
 * a interface só apresenta e devolve a escolha.
 */
export function BudgetDialog({
  open,
  decision,
  source,
  pending,
  onCancel,
  onAuthorize,
  onClose,
}: {
  open: boolean;
  decision: BudgetDecisionPresentation | undefined;
  source: "approval" | "generation";
  pending: boolean;
  onCancel: () => void;
  onAuthorize: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open && decision !== undefined} onClose={onClose} labelledBy="budget-dialog-title">
      {decision && (
        <div>
          <div className="border-b border-zinc-100 px-5 pt-5 pb-4">
            <p className="text-xs font-semibold tracking-wider text-amber-700 uppercase">Orçamento excedido</p>
            <h2 id="budget-dialog-title" className="mt-1 text-lg font-semibold tracking-tight">
              Esta geração passa do seu limite
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Nada foi gerado. {source === "generation" ? "A geração está pausada aguardando sua decisão." : "Decida antes de continuar."}
            </p>
          </div>
          <dl className="space-y-2.5 px-5 py-4 text-sm">
            <Row label={decision.scopeLabel} value={formatBrl(decision.limitBrl)} />
            <Row label="Custo atual" value={formatBrl(decision.currentBrl)} />
            <Row label="Próxima geração estimada" value={formatBrl(decision.nextBrl)} />
            <div className="border-t border-zinc-100 pt-2.5">
              <Row label="Total projetado" value={formatBrl(decision.projectedBrl)} strong />
            </div>
          </dl>
          <p className="mx-5 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Isso ultrapassa seu limite em <span className="font-semibold tabular">{formatBrl(decision.excessBrl)}</span>.
            {!decision.canAuthorize && " Esta campanha não permite autorizar gastos acima do limite."}
          </p>
          <div className="mt-4 flex flex-col-reverse gap-2 border-t border-zinc-100 px-5 py-4 sm:flex-row sm:justify-end">
            <button type="button" className={buttonClasses("secondary", "md")} onClick={onCancel} disabled={pending}>
              {source === "generation" ? "Cancelar geração" : "Cancelar"}
            </button>
            {decision.canAuthorize && (
              <button type="button" className={buttonClasses("primary", "md")} onClick={onAuthorize} disabled={pending}>
                {pending && <Spinner />}
                Autorizar até {formatBrl(decision.authorizeUpToBrl)}
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "font-medium text-zinc-900" : "text-zinc-600"}>{label}</dt>
      <dd className={strong ? "text-base font-semibold tabular" : "font-medium tabular"}>{value}</dd>
    </div>
  );
}
