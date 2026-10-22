import { ChevronDown, Film, Wallet, Zap } from "lucide-react";
import Link from "next/link";
import { videosLabel, type CreditsView as CreditsData } from "@/application/credits";
import { apportion, dayKey, formatCredits } from "@/costs/credits";
import { formatBrl } from "@/lib/money";
import { AmbientGlow, Badge, Card, cx, EmptyState, focusRing, Progress } from "../ds";

/**
 * L8.2 — tela Créditos (dark nativo, Cinematic AI Studio). Presentacional: recebe a visão já
 * derivada do ledger. Valores REAIS sem "~"; nada estimado aparece como gasto.
 */

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function zonedTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** "Hoje · 09:42" · "Ontem · 18:10" · "12 out · 09:42" (no fuso dos créditos). */
export function historyTimeLabel(iso: string, now: Date, timeZone: string): string {
  const day = dayKey(iso, timeZone);
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 3600_000), timeZone);
  const [, m, d] = day.split("-").map(Number);
  const label = day === today ? "Hoje" : day === yesterday ? "Ontem" : `${d} ${MONTHS[m! - 1]}`;
  return `${label} · ${zonedTime(iso, timeZone)}`;
}

export function periodLabel(view: Pick<CreditsData, "period">): string {
  const month = new Intl.DateTimeFormat("pt-BR", { timeZone: view.period.timeZone, month: "long", year: "numeric" }).format(new Date(view.period.start));
  const zone = view.period.timeZone === "America/Sao_Paulo" ? "horário de Brasília" : view.period.timeZone;
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} · ${zone}`;
}

const STATE_TONE = { normal: "primary", low: "warning", empty: "danger" } as const;

function BalanceCard({ view }: { view: CreditsData }) {
  const videos = videosLabel(view);
  const pct = view.allowance > 0 ? (view.remaining / view.allowance) * 100 : 0;
  return (
    <Card padding="lg" className="relative isolate overflow-hidden lg:col-span-2">
      <AmbientGlow className="opacity-70" />
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-medium text-fg-muted">Saldo disponível</p>
        {view.state === "low" ? <Badge tone="warning" dot>Saldo baixo</Badge> : view.state === "empty" ? <Badge tone="danger" dot>Sem saldo</Badge> : null}
      </div>
      <p className={cx("mt-4 text-[56px] leading-none font-semibold tracking-[-0.045em] tabular sm:text-[72px]", view.state === "empty" ? "text-danger" : view.state === "low" ? "text-warning" : "text-fg")} data-testid="balance">
        {formatCredits(view.remaining)}
      </p>
      <p className="mt-2 text-caption font-medium tracking-[0.2em] text-fg-subtle uppercase">Créditos</p>
      <p className="mt-5 text-sm text-fg-muted">de <span className="font-mono text-fg tabular">{formatCredits(view.allowance)}</span> neste mês</p>
      <Progress className="mt-3" tone={STATE_TONE[view.state]} value={pct} label={`Saldo: ${formatCredits(view.remaining)} de ${formatCredits(view.allowance)} créditos`} />
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {videos ? (
          <p className="text-fg">{videos}
            <span className="ml-2 text-caption text-fg-subtle">{view.estimatedVideos!.basis === "average" ? "pela média dos seus vídeos recentes" : "pela estimativa atual de um vídeo de 30s"}</span>
          </p>
        ) : null}
        {view.overage > 0 ? <p className="text-warning">Excedente: <span className="font-mono tabular">{formatCredits(view.overage)}</span> créditos acima da franquia (informativo)</p> : null}
      </div>
    </Card>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card padding="md" className="flex items-start gap-4">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-fg/[0.04] text-fg-muted ring-1 ring-inset ring-line [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-caption text-fg-subtle">{label}</p>
        <p className="mt-1 text-heading font-semibold text-fg">{value}</p>
        {hint ? <p className="mt-0.5 text-caption text-fg-subtle">{hint}</p> : null}
      </div>
    </Card>
  );
}

/** Uso diário: SVG próprio (sem biblioteca). Tabela equivalente só para leitores de tela. */
export function DailyUsageChart({ days, now, timeZone }: { days: CreditsData["dailyUsage"]; now: Date; timeZone: string }) {
  if (days.length === 0) return <p className="py-10 text-center text-sm text-fg-muted">Nenhum crédito utilizado neste mês.</p>;
  const max = Math.max(...days.map((d) => d.credits), 1);
  const today = dayKey(now, timeZone);
  const slot = 24;
  const height = 120;
  const label = (date: string) => { const [, m, d] = date.split("-").map(Number); return `${d} ${MONTHS[m! - 1]}`; };
  return (
    <div>
      <div className="mb-2 flex justify-between text-caption text-fg-subtle"><span>máx. <span className="font-mono tabular">{formatCredits(max)}</span>/dia</span></div>
      <svg viewBox={`0 0 ${days.length * slot} ${height}`} preserveAspectRatio="none" className="h-36 w-full" aria-hidden>
        <line x1="0" x2={days.length * slot} y1={height - 0.5} y2={height - 0.5} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const h = d.credits > 0 ? Math.max(3, (d.credits / max) * (height - 8)) : 2;
          const isToday = d.date === today;
          return (
            <rect key={d.date} x={i * slot + 5} y={height - h} width={slot - 10} height={h} rx="2"
              className={cx("transition-opacity duration-(--dur-fast) hover:opacity-80", d.credits === 0 ? "fill-fg/10" : isToday ? "fill-primary-light" : "fill-primary/70")}>
              <title>{`${label(d.date)}: ${formatCredits(d.credits)} créditos`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-caption text-fg-subtle">
        <span>{label(days[0]!.date)}</span>
        {days.length > 2 ? <span>{label(days[Math.floor((days.length - 1) / 2)]!.date)}</span> : null}
        <span>{label(days.at(-1)!.date)}</span>
      </div>
      <table className="sr-only">
        <caption>Uso diário de créditos</caption>
        <tbody>{days.filter((d) => d.credits > 0).map((d) => <tr key={d.date}><th scope="row">{label(d.date)}</th><td>{formatCredits(d.credits)} créditos</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ServiceUsage({ services }: { services: CreditsData["usageByService"] }) {
  if (services.length === 0) return <p className="py-10 text-center text-sm text-fg-muted">Sem consumo por serviço neste mês.</p>;
  const pct = apportion(services.map((s) => s.credits), 100);
  return (
    <ul className="space-y-4">
      {services.map((s, i) => (
        <li key={s.id}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-fg">{s.label}</span>
            <span className="text-fg-muted"><span className="font-mono tabular text-fg">{formatCredits(s.credits)}</span> · {pct[i]}%</span>
          </div>
          <Progress size="xs" className="mt-2" value={pct[i]} label={`${s.label}: ${pct[i]}% do uso`} />
        </li>
      ))}
    </ul>
  );
}

function History({ items, now, timeZone }: { items: CreditsData["recent"]; now: Date; timeZone: string }) {
  if (items.length === 0) return <p className="py-10 text-center text-sm text-fg-muted">Nenhum crédito utilizado neste mês.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.projectId}>
          <details className="group">
            <summary className={cx("flex cursor-pointer list-none items-center gap-4 rounded-lg px-1 py-3.5 transition-colors duration-(--dur-fast) hover:bg-fg/[0.02] [&::-webkit-details-marker]:hidden", focusRing)}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-fg">{item.name}</p>
                <p className="mt-0.5 text-caption text-fg-subtle">{item.kind} · {historyTimeLabel(item.at, now, timeZone)}</p>
              </div>
              <span className="font-mono text-sm text-fg tabular">−{formatCredits(item.credits)}<span className="ml-1 font-sans text-caption text-fg-subtle">créditos</span></span>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-subtle transition-transform duration-(--dur-normal) ease-cf group-open:rotate-180" />
            </summary>
            <div className="mb-4 ml-1 animate-fade-in rounded-xl border border-line bg-surface-sunken px-4 py-3 text-sm">
              <dl className="space-y-1.5">
                {item.breakdown.map((b) => (
                  <div key={b.label} className="flex justify-between gap-3"><dt className="text-fg-muted">{b.label}</dt><dd className="font-mono tabular text-fg">{formatCredits(b.credits)}</dd></div>
                ))}
                <div className="flex justify-between gap-3 border-t border-line pt-1.5"><dt className="font-medium text-fg">Total</dt><dd className="font-mono font-semibold tabular text-fg">{formatCredits(item.credits)}</dd></div>
              </dl>
              {item.name !== "Projeto removido" ? <Link href={`/campaigns/${encodeURIComponent(item.projectId)}`} className={cx("mt-3 inline-block rounded text-caption font-medium text-primary-light hover:text-fg", focusRing)}>Abrir projeto →</Link> : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function CreditsHeader({ subtitle }: { subtitle?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-fg sm:text-[34px]">Créditos</h1>
        <p className="mt-1.5 text-body text-fg-muted">Acompanhe o consumo do seu estúdio.</p>
      </div>
      {subtitle ? <p className="text-caption text-fg-subtle">{subtitle}</p> : null}
    </header>
  );
}

export function CreditsScreen({ view, now }: { view: CreditsData; now: Date }) {
  const tz = view.period.timeZone;
  return (
    <div className="space-y-6">
      <CreditsHeader subtitle={periodLabel(view)} />
      <div className="grid gap-4 lg:grid-cols-3">
        <BalanceCard view={view} />
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <Stat icon={<Zap />} label="Uso este mês" value={<><span className="font-mono tabular">{formatCredits(view.used)}</span> <span className="text-sm font-normal text-fg-muted">créditos</span></>} />
          <Stat icon={<Film />} label="Vídeos gerados" value={<span className="font-mono tabular">{view.videosGenerated}</span>} hint="vídeos reais concluídos no mês" />
          <Stat icon={<Wallet />} label="Custo real" value={<span className="font-mono tabular">{formatBrl(view.usedBrl)}</span>} hint="soma do ledger (providers)" />
        </div>
      </div>
      {view.used === 0 ? (
        <EmptyState title="Nenhum crédito utilizado neste mês." description={`Seu saldo está completo: ${formatCredits(view.allowance)} créditos. O consumo aparece aqui conforme você gera vídeos.`} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card padding="md" className="lg:col-span-2">
              <h2 className="mb-4 text-heading font-semibold text-fg">Uso diário</h2>
              <DailyUsageChart days={view.dailyUsage} now={now} timeZone={tz} />
            </Card>
            <Card padding="md">
              <h2 className="mb-5 text-heading font-semibold text-fg">Consumo por serviço</h2>
              <ServiceUsage services={view.usageByService} />
            </Card>
          </div>
          <Card padding="md">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-heading font-semibold text-fg">Histórico</h2>
              <span className="text-caption text-fg-subtle">por projeto, neste mês</span>
            </div>
            <History items={view.recent} now={now} timeZone={tz} />
          </Card>
        </>
      )}
      <p className="text-caption text-fg-subtle">1 crédito = R$ {(1 / view.creditsPerBrl).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} de custo real. Créditos vêm do ledger de custos; nada é cobrado à parte.</p>
    </div>
  );
}

export function CreditsUnavailable() {
  return (
    <div className="space-y-6">
      <CreditsHeader />
      <EmptyState icon={<Zap />} title="Créditos indisponíveis" description="Os créditos ainda não foram configurados neste servidor. O consumo real continua registrado no ledger." />
    </div>
  );
}
