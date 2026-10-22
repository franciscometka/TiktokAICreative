import { Zap } from "lucide-react";
import { cx, Tooltip } from "../ds";

/**
 * L8.1 — lugar reservado para o saldo de créditos. O saldo REAL só existe a partir do L8.2:
 * até lá o badge mostra apenas "Créditos", sem número (nada que pareça dado real).
 */
export function CreditsBadge({ className }: { className?: string }) {
  return (
    <Tooltip side="bottom" content="Saldo e uso de créditos chegam em breve.">
      <span tabIndex={0} aria-disabled="true" data-credits="placeholder"
        className={cx(
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-caption font-medium text-fg-subtle",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-light [&_svg]:size-3.5",
          className,
        )}>
        <Zap aria-hidden />Créditos
      </span>
    </Tooltip>
  );
}
