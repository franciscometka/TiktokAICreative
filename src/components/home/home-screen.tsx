"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { ImageView } from "@/application/campaign-view";
import { createHref, dayPeriod, greeting, type DayPeriod, type HomeStat } from "@/application/home-view";
import type { ProjectCard } from "@/application/project-v2-view";
import { DEFAULT_STYLE_PRESET, STYLE_PRESETS, type StylePresetId } from "@/application/style-presets";
import { workerStatusCopy, type WorkerStatusView } from "@/application/worker-status";
import { formatCredits } from "@/costs/credits";
import { AmbientGlow, buttonClass, Card, cx, focusRing, interactive, Skeleton, Spark, StatusDot, Textarea } from "../ds";
import { useShellStatusContext } from "../shell/shell-status-context";
import { PhotoDrop } from "../upload/photo-drop";
import { RecentProjects } from "./recent-projects";

/**
 * L8.3 — Home do Cinematic AI Studio (dark nativo). Hero com saudação pela hora do NAVEGADOR,
 * composer (foto + ideia + preset → /create pré-preenchido; a Home nunca cria projeto), mini
 * dashboard só com dados reais e os 4 projetos mais recentes.
 */

const subscribeNoop = () => () => undefined;

/** Hora local só no cliente; no servidor/hidratação = null (sem mismatch). */
function useDayPeriod(): DayPeriod | null {
  return useSyncExternalStore(subscribeNoop, () => dayPeriod(new Date().getHours()), () => null);
}

export interface HomeScreenProps {
  name: string | null;
  productId: string;
  stats: HomeStat[];
  recent: ProjectCard[];
}

export function HomeScreen({ name, productId, stats, recent }: HomeScreenProps) {
  const period = useDayPeriod();
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-12 sm:px-8">
      <section className="relative isolate -mx-4 px-4 pt-10 pb-2 sm:-mx-8 sm:px-8 sm:pt-16" aria-labelledby="home-title">
        {/* Glow só no hero, esmaecendo para baixo (sem borda dura sobre o composer). */}
        <AmbientGlow className="[mask-image:linear-gradient(to_bottom,#000_45%,transparent)]" />
        <h1 id="home-title" className="text-[30px] leading-tight font-semibold tracking-tight text-fg sm:text-display">
          {greeting(name ? period : null, name)} <Spark gradient />
        </h1>
        <p className="mt-2 text-body text-fg-muted">Transforme um produto em conteúdo que vende.</p>
        <Composer productId={productId} />
      </section>

      <MiniDashboard stats={stats} />

      <section className="mt-12" aria-labelledby="recent-title">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 id="recent-title" className="text-heading font-semibold text-fg">Projetos recentes</h2>
          {recent.length > 0 ? <Link href="/projects" className={cx("inline-flex items-center gap-1 text-sm font-medium text-fg-muted hover:text-fg", interactive, focusRing)}>Ver todos<ArrowRight className="size-3.5" aria-hidden /></Link> : null}
        </div>
        <RecentProjects cards={recent} />
      </section>
    </main>
  );
}

export function Composer({ productId }: { productId: string }) {
  const [images, setImages] = useState<ImageView[]>([]);
  const [idea, setIdea] = useState("");
  const [preset, setPreset] = useState<StylePresetId>(DEFAULT_STYLE_PRESET);
  const href = createHref({ productId, imageId: images[0]?.id, idea, preset });
  return (
    <Card padding="none" className="mt-7 p-3 sm:p-4" data-home-composer>
      <div className="flex gap-3 sm:gap-4">
        <div className="w-24 shrink-0 sm:w-36">
          <PhotoDrop productId={productId} images={images} onChange={setImages} size="tile" />
        </div>
        <div className="min-w-0 flex-1">
          <Textarea aria-label="Conte o que você quer criar" rows={4} maxLength={2000} value={idea} onChange={(e) => setIdea(e.target.value)}
            placeholder="Conte o que você quer criar..." className="h-24 sm:h-36" />
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Estilo do vídeo" className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:px-0">
          {STYLE_PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === preset} onClick={() => setPreset(p.id)}
              className={cx("h-8 shrink-0 rounded-full px-3 text-[13px] font-medium whitespace-nowrap ring-1 ring-inset", interactive, focusRing,
                p.id === preset ? "bg-primary-soft text-fg ring-primary/40" : "text-fg-muted ring-line hover:bg-surface-hover hover:text-fg")}>
              {p.homeLabel}
            </button>
          ))}
        </div>
        <Link href={href} className={buttonClass({ variant: "ai", size: "lg" })} data-home-cta>
          <Spark inherit />Criar vídeo
        </Link>
      </div>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface/60 px-4 py-3">
      <p className="truncate text-caption text-fg-subtle">{label}</p>
      <div className="mt-1 truncate text-heading font-semibold text-fg tabular">{children}</div>
    </div>
  );
}

export function WorkerStat({ worker, now }: { worker: WorkerStatusView | null; now: Date }) {
  if (!worker) return <Stat label="Worker"><Skeleton className="mt-1 h-5 w-24" /></Stat>;
  const copy = workerStatusCopy(worker, now);
  return (
    <Stat label="Worker">
      <span className="flex items-center gap-2 text-sm font-medium" data-worker-state={worker.state}>
        {worker.state === "unknown"
          ? <span aria-hidden className="size-2 shrink-0 rounded-full border border-fg-subtle" />
          : <StatusDot status={worker.state === "offline" ? "warning" : "online"} live={worker.state === "online"} />}
        {copy.label}
      </span>
    </Stat>
  );
}

/** Só números reais; o worker vem do MESMO status que o shell já consulta (sem polling extra). */
export function MiniDashboard({ stats }: { stats: HomeStat[] }) {
  const { status, now } = useShellStatusContext();
  return (
    <section aria-label="Resumo do estúdio" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <Stat key={s.id} label={s.label}>{s.id === "credits" ? <Link href="/credits" className={cx("hover:text-primary-light", interactive, focusRing)}>{formatCredits(s.value)}</Link> : formatCredits(s.value)}</Stat>
      ))}
      <WorkerStat worker={status?.worker ?? null} now={now} />
    </section>
  );
}
