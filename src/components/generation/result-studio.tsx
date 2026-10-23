"use client";

import { ArrowLeft, Download, FolderOpen, Plus } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import type { GenerationSource, GenerationView } from "@/application/generation-view";
import type { ChangeRequest } from "@/domain/change-request";
import { formatCredits } from "@/costs/credits";
import { AmbientGlow, Button, buttonClass, Card, cx, focusRing, interactive, Segmented, Spark, Textarea } from "../ds";
import { ProjectStatusBadge } from "../projects/project-status";
import type { ProjectV2Handlers } from "../v2/project-v2-panel";
import { SceneTimeline, SendToPlayer } from "./scene-timeline";

/**
 * L8.6 — Result Studio (projeto concluído). Player 9:16 grande com o vídeo FINAL real; uma cena
 * pronta pode ir para o MESMO player (um único <video> na página). Painel com ações reais, dados
 * do resultado (só o que existe), créditos reais do ledger por serviço, versões anteriores do
 * render quando existem e o pedido de mudança existente (texto honesto: estima, não edita).
 */

export function ResultStudio({ view, source, campaignId, onEstimate, localMode, advancedHref }: {
  view: GenerationView;
  source: GenerationSource;
  campaignId: string;
  onEstimate: ProjectV2Handlers["estimateChange"];
  /** "Planejar de novo com ajustes" (?from=) só existe no modo local. */
  localMode: boolean;
  advancedHref: string;
}) {
  const final = source.v2.result!;
  const [sceneId, setSceneId] = useState<string | undefined>();
  const [inPlayer, setInPlayer] = useState<"final" | string>("final");
  const playerScene = inPlayer === "final" ? undefined : view.scenes.find((s) => s.id === inPlayer && s.videoUrl);
  const src = playerScene?.videoUrl ?? final.videoUrl;
  const meta = [view.summary.find((r) => r.label === "Duração")?.value, view.summary.find((r) => r.label === "Qualidade")?.value, view.summary.find((r) => r.label === "Avatar")?.value].filter(Boolean);
  const result = view.result;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-12 sm:px-8 sm:pt-10" data-generation="done" data-result-studio>
      <Link href="/projects" className={cx("inline-flex items-center gap-1.5 text-caption font-medium text-fg-subtle hover:text-fg", interactive, focusRing)}><ArrowLeft className="size-3.5" aria-hidden />Projetos</Link>
      <p className="sr-only" aria-live="polite">Seu vídeo está pronto</p>

      <header className="relative isolate mt-4">
        <AmbientGlow className="-top-10 [mask-image:linear-gradient(to_bottom,#000_40%,transparent)]" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-fg sm:text-title" data-headline>{view.title}</h1>
          <ProjectStatusBadge status="ready" label="Pronto" />
        </div>
        {meta.length ? <p className="mt-1.5 text-sm text-fg-muted tabular" data-result-meta>{meta.join(" · ")}</p> : null}
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="mx-auto w-full max-w-[22rem]">
            {playerScene ? (
              <div className="mb-3 flex justify-center">
                <Segmented label="O que mostrar no player" size="sm" value={inPlayer === "final" ? "final" : "scene"} onChange={(v) => setInPlayer(v === "final" ? "final" : playerScene.id)}
                  options={[{ value: "final", label: "Vídeo final" }, { value: "scene", label: `Cena ${playerScene.number}` }]} />
              </div>
            ) : null}
            <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-black ring-1 ring-line shadow-raise">
              <video key={src} src={src} controls playsInline preload="metadata" aria-label={playerScene ? `Cena ${playerScene.number}` : `Vídeo final: ${view.title}`}
                className="size-full animate-reveal object-contain" data-result-player={playerScene ? "scene" : "final"} />
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          <Card padding="none" className="p-5 sm:p-6" id="result" data-result>
            <p className="flex items-center gap-2 text-heading font-semibold text-fg"><Spark gradient />Seu vídeo está pronto</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <a href={final.downloadUrl} className={buttonClass({ variant: "primary", size: "lg" })}><Download aria-hidden />Baixar vídeo</a>
              <Link href="/create" className={buttonClass({ variant: "secondary", size: "lg" })}><Plus aria-hidden />Criar outro vídeo</Link>
              <Link href="/projects" className={buttonClass({ variant: "ghost", size: "lg" })}><FolderOpen aria-hidden />Voltar aos projetos</Link>
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm sm:grid-cols-3" data-result-details>
              {view.summary.map((row) => <div key={row.label}><dt className="text-caption text-fg-subtle">{row.label}</dt><dd className="mt-0.5 text-fg tabular">{row.value}</dd></div>)}
              {result?.sceneCount ? <div><dt className="text-caption text-fg-subtle">Cenas</dt><dd className="mt-0.5 text-fg tabular">{result.sceneCount}</dd></div> : null}
              {result ? <div><dt className="text-caption text-fg-subtle">Concluído em</dt><dd className="mt-0.5 text-fg tabular">{result.dateLabel}</dd></div> : null}
              {view.credits?.mode === "final" ? <div><dt className="text-caption text-fg-subtle">Créditos</dt><dd className="mt-0.5 font-medium text-fg tabular" data-credits="final">{formatCredits(view.credits.used)} créditos utilizados</dd></div> : null}
            </dl>

            {result?.breakdown.length ? (
              <details className="group mt-4 rounded-xl bg-surface-sunken px-4 py-3" data-credit-breakdown>
                <summary className={cx("cursor-pointer text-caption font-medium text-fg-muted hover:text-fg", focusRing)}>Créditos por serviço</summary>
                <ul className="mt-3 space-y-1.5 text-sm tabular">
                  {result.breakdown.map((b) => <li key={b.label} className="flex justify-between gap-3"><span className="text-fg-muted">{b.label}</span><span className="text-fg">{formatCredits(b.credits)}</span></li>)}
                </ul>
              </details>
            ) : null}
          </Card>

          {result?.versions.length ? (
            <Card padding="none" className="p-5 sm:p-6" data-versions>
              <h2 className="text-sm font-medium text-fg">Versões anteriores</h2>
              <ul className="mt-3 divide-y divide-line text-sm">
                {result.versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-fg-muted">{v.label}</span>
                    <a href={v.downloadUrl} className={cx("inline-flex items-center gap-1 text-caption font-medium text-primary-light hover:text-fg", interactive, focusRing)}><Download className="size-3.5" aria-hidden />Baixar</a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <ChangeRequestCard campaignId={campaignId} onEstimate={onEstimate} localMode={localMode} />
        </div>
      </div>

      {view.scenes.length ? (
        <div className="mt-10">
          <SceneTimeline scenes={view.scenes} selectedId={sceneId} onSelect={setSceneId}
            renderMedia={(scene) => <SendToPlayer scene={scene} active={inPlayer === scene.id} onShow={() => setInPlayer(scene.id)} />} />
        </div>
      ) : null}

      <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-5 text-caption text-fg-subtle">
        {source.v2.voice ? <span title={source.v2.voice.reason}>{source.v2.voice.label}</span> : null}
        {source.v2.avatar?.reason ? <span>{source.v2.avatar.reason}</span> : null}
        <a href={advancedHref} className={cx("font-medium text-fg-muted hover:text-fg", interactive, focusRing)}>Detalhes técnicos</a>
      </footer>
    </main>
  );
}

/** Pedido de mudança existente: só ESTIMA (nada é cobrado nem editado aqui). */
export function ChangeRequestCard({ campaignId, onEstimate, localMode }: { campaignId: string; onEstimate: ProjectV2Handlers["estimateChange"]; localMode: boolean }) {
  const [text, setText] = useState("");
  const [change, setChange] = useState<ChangeRequest | null>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const update = () => startTransition(async () => {
    const r = await onEstimate(text);
    if (r.ok) { setChange(r.value); setError(undefined); } else { setChange(null); setError(r.error.message); }
  });
  return (
    <Card padding="none" className="p-5 sm:p-6" data-change-request>
      <label htmlFor="change-request" className="text-sm font-medium text-fg">Quer mudar alguma coisa?</label>
      <p className="mt-1 text-caption text-fg-subtle">Descreva a mudança e veja quanto custaria. Nada é cobrado nem alterado nesta etapa.</p>
      <Textarea id="change-request" rows={3} maxLength={500} className="mt-3" placeholder="Deixe a fala mais natural..." value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={pending} disabled={!text.trim()} onClick={update}>Ver estimativa da mudança</Button>
        {localMode ? <Link href={`/create?from=${encodeURIComponent(campaignId)}`} className={cx("text-caption font-medium text-fg-muted hover:text-fg", interactive, focusRing)}>Planejar de novo com ajustes</Link> : null}
      </div>
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      {change ? (
        <div className="mt-4 rounded-xl bg-surface-sunken p-4 text-sm" aria-live="polite">
          <p className="font-medium text-fg tabular">{change.estimatedCost.label}</p>
          <p className="mt-1 text-fg-muted">Nada foi cobrado. A aplicação automática de mudanças ainda não está disponível nesta tela{localMode ? ": use “Planejar de novo com ajustes” para criar uma nova versão." : "."}</p>
        </div>
      ) : null}
    </Card>
  );
}
