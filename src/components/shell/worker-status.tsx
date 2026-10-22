import { workerStatusCopy, type WorkerStatusView } from "@/application/worker-status";
import { cx, Skeleton, StatusDot, Tooltip } from "../ds";

/**
 * L8.1 — status do worker. Presentacional (testável sem rede): recebe o status já consultado.
 * - `pill`: topbar desktop, com tooltip (hover E foco de teclado);
 * - `panel`: sidebar e menu mobile, texto completo visível (nada depende de hover);
 * - `dot`: topbar mobile, só o ponto com nome acessível.
 * `null` = ainda consultando (placeholder do mesmo tamanho, sem CLS).
 */

function Dot({ status }: { status: WorkerStatusView }) {
  if (status.state === "unknown") return <span aria-hidden className="size-2 shrink-0 rounded-full border border-fg-subtle" />;
  return <StatusDot status={status.state === "offline" ? "warning" : "online"} live={status.state === "online"} />;
}

export function WorkerStatus({ status, variant = "pill", now, className }: { status: WorkerStatusView | null; variant?: "pill" | "panel" | "dot"; now?: Date; className?: string }) {
  if (!status) {
    return variant === "panel"
      ? <div className={cx("space-y-2 p-0.5", className)} aria-label="Verificando worker"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-40" /></div>
      : <Skeleton rounded="full" className={cx(variant === "dot" ? "size-8" : "h-8 w-32", className)} />;
  }
  const copy = workerStatusCopy(status, now);

  if (variant === "panel") {
    return (
      <div role="status" data-worker-state={status.state} className={cx("text-caption", className)}>
        <p className="flex items-center gap-2 font-medium text-fg"><Dot status={status} />{copy.label}</p>
        <p className="mt-1.5 text-fg-muted">{copy.title}</p>
        {copy.lines.map((line) => <p key={line} className="text-fg-subtle">{line}</p>)}
      </div>
    );
  }

  const tip = (
    <span className="block">
      <span className="block font-medium">{copy.title}</span>
      {copy.lines.map((line) => <span key={line} className="block text-fg-muted">{line}</span>)}
    </span>
  );

  if (variant === "dot") {
    return (
      <span role="status" data-worker-state={status.state} aria-label={copy.label} title={copy.label} className={cx("grid size-8 place-items-center", className)}>
        <Dot status={status} />
      </span>
    );
  }

  return (
    <Tooltip side="bottom" content={tip}>
      <span role="status" tabIndex={0} data-worker-state={status.state}
        className={cx(
          "inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-caption font-medium whitespace-nowrap text-fg-muted",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-light",
          className,
        )}>
        <Dot status={status} />{copy.label}
      </span>
    </Tooltip>
  );
}
