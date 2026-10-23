"use client";

import { AlertTriangle, Clapperboard } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import type { GenerationScene, SceneStatus } from "@/application/generation-view";
import { Badge, cx, focusRing, interactive, Spinner } from "../ds";
import { CheckIcon } from "./stage-stepper";

/**
 * L8.5 — timeline de cenas (reutilizável no L8.6). Cada cena: número, duração, status e, quando o
 * arquivo existe, um player SÓ para a cena selecionada (nenhum vídeo carregado nas outras).
 * Selecionar mostra fala, descrição visual, movimento e status. Sem edição (ainda não suportada).
 * Teclado: setas/Home/End movem a seleção (tablist).
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

export function SceneTimeline({ scenes, defaultSelected }: { scenes: GenerationScene[]; defaultSelected?: string }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(defaultSelected);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (scenes.length === 0) return null;
  const selected = scenes.find((s) => s.id === selectedId) ?? scenes.find((s) => s.status === "generating" || s.status === "failed") ?? scenes[0]!;
  const index = scenes.indexOf(selected);

  function onKeyDown(event: KeyboardEvent) {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? scenes.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = (next + scenes.length) % scenes.length;
    setSelectedId(scenes[target]!.id);
    refs.current[target]?.focus();
  }

  return (
    <section aria-labelledby="scenes-title" data-scene-timeline>
      <h2 id="scenes-title" className="mb-3 text-heading font-semibold text-fg">Cenas</h2>
      <div role="tablist" aria-label="Cenas do vídeo" onKeyDown={onKeyDown} className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {scenes.map((scene, i) => {
          const isSelected = scene.id === selected.id;
          const status = STATUS[scene.status];
          return (
            <button key={scene.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`scene-tab-${scene.id}`} aria-selected={isSelected} aria-controls="scene-panel"
              tabIndex={isSelected ? 0 : -1} onClick={() => setSelectedId(scene.id)} data-scene-status={scene.status}
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

      <div role="tabpanel" id="scene-panel" aria-labelledby={`scene-tab-${selected.id}`} className="mt-3 grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,9rem)_1fr] sm:p-5" data-scene-detail={selected.number}>
        <div className="mx-auto w-full max-w-[9rem]">
          {selected.videoUrl
            ? <video key={selected.videoUrl} src={selected.videoUrl} controls playsInline preload="metadata" aria-label={`Cena ${selected.number}`} className="aspect-[9/16] w-full animate-reveal rounded-xl bg-black object-contain" />
            : <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-surface-sunken text-caption text-fg-subtle ring-1 ring-inset ring-line">{selected.status === "failed" ? "Sem vídeo" : "Ainda não gerada"}</div>}
        </div>
        <dl className="min-w-0 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">Cena {selected.number}</span>
            <Badge tone={STATUS[selected.status].tone}>{STATUS[selected.status].label}</Badge>
            <span className="text-caption text-fg-subtle tabular">{selected.durationSeconds}s</span>
            {selected.simulated ? <Badge>Simulação</Badge> : null}
          </div>
          {selected.narration ? <div><dt className="text-caption text-fg-subtle">Fala</dt><dd className="mt-0.5 text-fg">“{selected.narration}”</dd></div> : null}
          {selected.visual ? <div><dt className="text-caption text-fg-subtle">Descrição visual</dt><dd className="mt-0.5 text-fg-muted">{selected.visual}</dd></div> : null}
          {selected.motion ? <div><dt className="text-caption text-fg-subtle">Movimento</dt><dd className="mt-0.5 text-fg-muted">{selected.motion}</dd></div> : null}
        </dl>
      </div>
    </section>
  );
}
