"use client";

import { AlertTriangle, Clapperboard, Play } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GenerationScene, SceneStatus } from "@/application/generation-view";
import { Badge, Button, cx, focusRing, interactive, Spinner } from "../ds";
import { CheckIcon } from "./stage-stepper";

/**
 * L8.5/L8.6 — timeline de cenas REUTILIZÁVEL (geração e Result Studio). Cada cena: número,
 * duração e status. Nenhum vídeo é montado na lista; o detalhe da cena selecionada mostra fala,
 * descrição visual, movimento e status, e a mídia é carregada só quando o usuário pede
 * (`renderMedia` permite, por ex., mandar a cena para o player principal). Teclado: tablist com
 * setas/Home/End; seleção controlada (`selectedId`/`onSelect`) ou interna.
 */

const STATUS: Record<SceneStatus, { label: string; tone: "success" | "primary" | "neutral" | "danger" }> = {
  ready: { label: "Pronta", tone: "success" },
  generating: { label: "Gerando", tone: "primary" },
  waiting: { label: "Aguardando", tone: "neutral" },
  failed: { label: "Falhou", tone: "danger" },
};

function StatusIcon({ status }: { status: SceneStatus }) {
  if (status === "ready") return <CheckIcon className="size-3.5 text-success" />;
  if (status === "generating") return <Spinner className="size-3.5 text-primary-light" />;
  if (status === "failed") return <AlertTriangle className="size-3.5 text-danger" aria-hidden />;
  return <span aria-hidden className="size-1.5 rounded-full bg-fg-subtle" />;
}

/** Mídia padrão do detalhe: player só depois do clique (um por vez, sem autoplay). */
function OnDemandPlayer({ scene }: { scene: GenerationScene }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!scene.videoUrl) {
    return <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-surface-sunken text-center text-caption text-fg-subtle ring-1 ring-inset ring-line">{scene.status === "failed" ? "Sem vídeo" : scene.simulated ? "Simulação: sem vídeo real" : "Ainda não gerada"}</div>;
  }
  if (open === scene.videoUrl) {
    return <video key={scene.videoUrl} src={scene.videoUrl} controls playsInline preload="metadata" aria-label={`Cena ${scene.number}`} className="aspect-[9/16] w-full animate-reveal rounded-xl bg-black object-contain" />;
  }
  return (
    <button type="button" onClick={() => setOpen(scene.videoUrl)} className={cx("grid aspect-[9/16] w-full place-items-center rounded-xl bg-surface-sunken text-caption font-medium text-fg-muted ring-1 ring-inset ring-line hover:text-fg", interactive, focusRing)} data-scene-play>
      <span className="flex flex-col items-center gap-2"><span className="grid size-10 place-items-center rounded-full bg-primary-soft text-primary-light ring-1 ring-inset ring-primary/30"><Play className="size-4" aria-hidden /></span>Ver cena {scene.number}</span>
    </button>
  );
}

export function SceneTimeline({ scenes, defaultSelected, selectedId: controlled, onSelect, renderMedia, title = "Cenas" }: {
  scenes: GenerationScene[];
  defaultSelected?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  renderMedia?: (scene: GenerationScene) => ReactNode;
  title?: string;
}) {
  const [internal, setInternal] = useState<string | undefined>(defaultSelected);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (scenes.length === 0) return null;
  const chosen = controlled ?? internal;
  const selected = scenes.find((s) => s.id === chosen) ?? scenes.find((s) => s.status === "generating" || s.status === "failed") ?? scenes[0]!;
  const index = scenes.indexOf(selected);
  const select = (id: string) => { setInternal(id); onSelect?.(id); };

  function onKeyDown(event: KeyboardEvent) {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? scenes.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = (next + scenes.length) % scenes.length;
    select(scenes[target]!.id);
    refs.current[target]?.focus();
  }

  return (
    <section aria-labelledby="scenes-title" data-scene-timeline>
      <h2 id="scenes-title" className="mb-3 text-heading font-semibold text-fg">{title}</h2>
      <div role="tablist" aria-label="Cenas do vídeo" onKeyDown={onKeyDown} className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {scenes.map((scene, i) => {
          const isSelected = scene.id === selected.id;
          const status = STATUS[scene.status];
          return (
            <button key={scene.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`scene-tab-${scene.id}`} aria-selected={isSelected} aria-controls="scene-panel"
              tabIndex={isSelected ? 0 : -1} onClick={() => select(scene.id)} data-scene-status={scene.status}
              className={cx("w-28 shrink-0 snap-start rounded-xl border p-2.5 text-left", interactive, focusRing,
                isSelected ? "border-primary-light/60 bg-primary-soft ring-1 ring-primary-light/40" : "border-line bg-surface-sunken hover:border-line-strong hover:bg-surface-hover",
                scene.status === "failed" && !isSelected && "border-danger/40")}>
              <span key={scene.status} className="grid aspect-[9/12] animate-fade-in place-items-center rounded-lg bg-surface ring-1 ring-inset ring-line">
                {scene.status === "ready" ? <Clapperboard className="size-5 text-success" aria-hidden /> : <StatusIcon status={scene.status} />}
              </span>
              <span className="mt-2 flex items-center justify-between gap-1 text-caption">
                <span className="font-medium text-fg">Cena {scene.number}</span>
                <span className="text-fg-subtle tabular">{scene.durationSeconds}s</span>
              </span>
              <span className={cx("mt-0.5 flex items-center gap-1 text-caption", scene.status === "failed" ? "text-danger" : scene.status === "ready" ? "text-success" : scene.status === "generating" ? "text-primary-light" : "text-fg-subtle")}>
                <StatusIcon status={scene.status} />{status.label}
              </span>
            </button>
          );
        })}
      </div>

      <div key={selected.id} role="tabpanel" id="scene-panel" aria-labelledby={`scene-tab-${selected.id}`} className="mt-3 grid animate-fade-in gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,9rem)_1fr] sm:p-5" data-scene-detail={selected.number}>
        <div className="mx-auto w-full max-w-[9rem]">{renderMedia ? renderMedia(selected) : <OnDemandPlayer scene={selected} />}</div>
        <dl className="min-w-0 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">Cena {selected.number}</span>
            <Badge tone={STATUS[selected.status].tone}>{STATUS[selected.status].label}</Badge>
            {selected.simulated ? <Badge>Simulação</Badge> : null}
          </div>
          <div><dt className="text-caption text-fg-subtle">Duração</dt><dd className="mt-0.5 text-fg tabular">{selected.durationSeconds}s</dd></div>
          {selected.narration ? <div><dt className="text-caption text-fg-subtle">Fala</dt><dd className="mt-0.5 text-fg">“{selected.narration}”</dd></div> : null}
          {selected.visual ? <div><dt className="text-caption text-fg-subtle">Descrição visual</dt><dd className="mt-0.5 text-fg-muted">{selected.visual}</dd></div> : null}
          {selected.motion ? <div><dt className="text-caption text-fg-subtle">Movimento</dt><dd className="mt-0.5 text-fg-muted">{selected.motion}</dd></div> : null}
        </dl>
      </div>
    </section>
  );
}

/** Mídia do detalhe no Result Studio: manda a cena para o player principal (um player só). */
export function SendToPlayer({ scene, active, onShow }: { scene: GenerationScene; active: boolean; onShow: () => void }) {
  if (!scene.videoUrl) return <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-surface-sunken text-caption text-fg-subtle ring-1 ring-inset ring-line">Sem vídeo</div>;
  return (
    <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-surface-sunken p-2 ring-1 ring-inset ring-line">
      {active ? <span className="text-center text-caption font-medium text-primary-light" data-scene-in-player>No player</span>
        : <Button size="sm" variant="secondary" icon={<Play />} onClick={onShow} data-scene-play>Ver no player</Button>}
    </div>
  );
}
