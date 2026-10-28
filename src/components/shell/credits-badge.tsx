import { Zap } from "lucide-react";
import Link from "next/link";
import { videosLabel, type CreditsSummary } from "@/application/credits";
import { formatCredits } from "@/costs/credits";
import { cx, focusRing, Progress, Skeleton, Tooltip } from "../ds";

/**
 * L8.2 — saldo de créditos no shell (derivado do ledger; nunca um valor inventado).
 * - `loading`: ainda consultando (placeholder do mesmo tamanho);
 * - `summary = null`: créditos indisponíveis (não configurados) — NUNCA "0 créditos";
 * - estados: normal · low (≤ 20%, âmbar) · empty (0, danger).
 */

const TONE = {
  normal: { icon: "text-primary-light", text: "text-fg", bar: "primary" },
  low: { icon: "text-warning", text: "text-warning", bar: "warning" },
  empty: { icon: "text-danger", text: "text-danger", bar: "danger" },
} as const;

function tipContent(summary: CreditsSummary) {
  const videos = videosLabel(summary);
  return (
    <span className="block min-w-44">
      <span className="block font-medium">Saldo mensal</span>
      <span className="block font-mono text-fg-muted tabular">{formatCredits(summary.remaining)} / {formatCredits(summary.allowance)}</span>
      {videos ? <span className="block text-fg-muted">{videos}</span> : null}
      <span className="mt-1 block text-primary-light">Ver uso →</span>
    </span>
  );
}

/** Topbar: discreto — ⚡ 6.760 (link para Créditos). */
export function CreditsBadge({ summary, loading = false, className }: { summary: CreditsSummary | null; loading?: boolean; className?: string }) {
  if (loading) return <Skeleton rounded="full" className={cx("h-8 w-24", className)} />;
  if (!summary) {
    return (
      <span data-credits="unavailable" className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-caption text-fg-subtle [&_svg]:size-3.5", className)}>
        <Zap aria-hidden />Créditos indisponíveis
      </span>
    );
  }
  const tone = TONE[summary.state];
  return (
    <Tooltip side="bottom" content={tipContent(summary)}>
      <Link href="/credits" data-credits={summary.state} aria-label={`${formatCredits(summary.remaining)} créditos disponíveis de ${formatCredits(summary.allowance)} — ver uso`}
        className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-caption font-medium transition-colors duration-(--dur-fast) hover:border-line-strong hover:bg-fg/[0.03] [&_svg]:size-3.5", focusRing, className)}>
        <Zap aria-hidden className={tone.icon} />
        <span className={cx("font-mono tabular", tone.text)}>{formatCredits(summary.remaining)}</span>
      </Link>
    </Tooltip>
  );
}

/** Sidebar / menu mobile: saldo, barra mínima, equivalência em vídeos e "Ver uso →". */
export function CreditsPanel({ summary, loading = false, onNavigate }: { summary: CreditsSummary | null; loading?: boolean; onNavigate?: () => void }) {
  if (loading) return <div className="space-y-2" aria-label="Carregando créditos"><Skeleton className="h-4 w-32" /><Skeleton className="h-[3px] w-full" /></div>;
  if (!summary) {
    return <p data-credits="unavailable" className="flex items-center gap-2 text-caption text-fg-subtle [&_svg]:size-3.5"><Zap aria-hidden />Créditos indisponíveis</p>;
  }
  const tone = TONE[summary.state];
  const videos = videosLabel(summary);
  return (
    <div data-credits={summary.state}>
      <p className="flex items-center gap-2 text-sm font-medium [&_svg]:size-3.5">
        <Zap aria-hidden className={tone.icon} />
        <span className={cx("font-mono tabular", tone.text)}>{formatCredits(summary.remaining)}</span>
        <span className="text-fg-muted">créditos</span>
      </p>
      <Progress size="xs" className="mt-2" tone={tone.bar} value={summary.allowance > 0 ? (summary.remaining / summary.allowance) * 100 : 0} label={`Saldo: ${formatCredits(summary.remaining)} de ${formatCredits(summary.allowance)} créditos`} />
      <div className="mt-2 flex items-center justify-between gap-2 text-caption">
        <span className="text-fg-subtle">{videos ?? (summary.state === "empty" ? "Sem saldo neste mês" : `de ${formatCredits(summary.allowance)} no mês`)}</span>
        <Link href="/credits" onClick={onNavigate} className={cx("shrink-0 rounded font-medium text-primary-light hover:text-fg", focusRing)}>Ver uso →</Link>
      </div>
    </div>
  );
}
