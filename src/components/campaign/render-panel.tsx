"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rerenderCreativeAction } from "@/app/actions";
import type { CreativeView } from "@/application/campaign-view";
import { formatSeconds } from "@/application/cost-presentation";
import type { UserError } from "@/application/user-errors";
import { formatBrl } from "@/lib/money";
import { buttonClasses, Notice, Spinner } from "../ui/primitives";

const MB = 1024 * 1024;

/**
 * Estado do render de um criativo: preparando/renderizando (progresso real quando existe),
 * interrompido (ação explícita), player do MP4 com download e "Renderizar novamente".
 */
export function RenderPanel({ creative, rendererIsReal }: { creative: CreativeView; rendererIsReal: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const { activity, interrupted, latestRender: video } = creative;

  const rerender = () =>
    startTransition(async () => {
      setError(null);
      const result = await rerenderCreativeAction(creative.jobId);
      if (!result.ok) setError(result.error);
      setConfirming(false);
      router.refresh();
    });

  const confirmBox = (title: string, body: string, cta: string) => (
    <Notice
      tone="amber"
      title={title}
      action={
        <div className="flex gap-2">
          <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirming(false)} disabled={pending}>
            Voltar
          </button>
          <button type="button" className={buttonClasses("primary", "sm")} onClick={rerender} disabled={pending}>
            {pending && <Spinner />}
            {cta}
          </button>
        </div>
      }
    >
      {body}
    </Notice>
  );

  return (
    <div className="space-y-3">
      {activity && <ActivityBox activity={activity} />}

      {interrupted &&
        (confirming
          ? confirmBox(
              "Retomar este criativo?",
              creative.jobStatus === "generating"
                ? "A geração foi interrompida. Retomar refaz só o que faltou, checando o orçamento antes de cada chamada."
                : "O render foi interrompido. Será criada uma nova versão do vídeo (render local, sem custo de API).",
              creative.jobStatus === "generating" ? "Retomar geração" : "Renderizar novamente",
            )
          : (
            <Notice
              tone="amber"
              title={creative.jobStatus === "generating" ? "Geração interrompida" : "Render interrompido"}
              action={
                <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirming(true)} disabled={!creative.canRerender}>
                  {creative.jobStatus === "generating" ? "Retomar geração" : "Renderizar novamente"}
                </button>
              }
            >
              O servidor parou antes de terminar. Nada recomeça sozinho.
            </Notice>
          ))}

      {creative.lastRenderError && !activity && (
        <Notice tone="red" title="O último render falhou">
          {creative.lastRenderError}
        </Notice>
      )}

      {video && (
        <div className="rounded-md border border-zinc-200 p-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="mx-auto w-full max-w-[240px] shrink-0 sm:mx-0">
              <div className="aspect-[9/16] overflow-hidden rounded-md bg-zinc-900">
                <video key={video.videoUrl} src={video.videoUrl} controls preload="metadata" playsInline className="size-full object-contain">
                  Seu navegador não reproduz MP4.
                </video>
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Vídeo renderizado · {video.renderId}</p>
                <p className="mt-1 text-sm text-zinc-700">
                  MP4 real 1080×1920. Vídeo IA e narração ainda são simulados: cenas de IA aparecem marcadas como
                  <span className="font-medium"> MOCK · VÍDEO IA</span> e o vídeo não tem som.
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <Stat label="Duração" value={video.durationSeconds !== null ? formatSeconds(video.durationSeconds) : "—"} />
                <Stat label="Tamanho" value={video.sizeBytes !== null ? `${(video.sizeBytes / MB).toFixed(1).replace(".", ",")} MB` : "—"} />
                <Stat label="Tempo de render" value={video.renderMs !== null ? formatSeconds(Math.round(video.renderMs / 100) / 10) : "—"} />
                <Stat label="Custo do render" value={`${formatBrl(0)} (local)`} />
              </dl>
              <div className="flex flex-wrap gap-2">
                <a href={video.videoUrl} target="_blank" rel="noreferrer" className={buttonClasses("secondary", "sm")}>
                  Assistir
                </a>
                <a href={video.downloadUrl} className={buttonClasses("primary", "sm")}>
                  Baixar MP4
                </a>
                {creative.canRerender && !confirming && (
                  <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setConfirming(true)}>
                    Renderizar novamente
                  </button>
                )}
              </div>
              {confirming && !interrupted &&
                confirmBox("Renderizar novamente?", "Cria uma nova versão; a atual continua disponível. Render local, sem custo de API.", "Renderizar")}
              {video.warnings.length > 0 && (
                <details className="text-xs text-zinc-600">
                  <summary className="cursor-pointer font-medium select-none">Avisos do render ({video.warnings.length})</summary>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                    {video.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              {creative.previousRenders.length > 0 && (
                <p className="text-xs text-zinc-500">
                  Versões anteriores:{" "}
                  {creative.previousRenders.map((r, i) => (
                    <span key={r.renderId}>
                      {i > 0 && " · "}
                      <a className="underline underline-offset-2 hover:text-zinc-900" href={r.downloadUrl}>
                        {r.renderId}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {!video && !activity && !interrupted && creative.jobStatus === "failed" && creative.canRerender && (
        <div className="flex justify-end">
          {confirming ? (
            confirmBox("Renderizar novamente?", "A mídia já está pronta; só o render é refeito (local, sem custo de API).", "Renderizar")
          ) : (
            <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setConfirming(true)}>
              Renderizar novamente
            </button>
          )}
        </div>
      )}

      {!rendererIsReal && creative.result && (
        <Notice tone="green" title="Concluído em modo de teste">
          RENDERER=mock: o fluxo foi validado, mas nenhum MP4 foi gerado. Use RENDERER=remotion para gerar o vídeo.
        </Notice>
      )}

      {error && (
        <Notice tone="red" title={error.title}>
          {error.message}
        </Notice>
      )}
    </div>
  );
}

function ActivityBox({ activity }: { activity: NonNullable<CreativeView["activity"]> }) {
  const known = activity.totalFrames !== null && activity.renderedFrames !== null && activity.totalFrames > 0;
  const steps = [
    { label: "Preparando assets", state: activity.phase === "generating" ? "current" : "done" },
    { label: "Renderizando", state: activity.phase === "rendering" ? "current" : "todo" },
    { label: "Concluído", state: "todo" },
  ] as const;
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/60 p-4">
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {steps.map((s) => (
          <li key={s.label} className={`flex items-center gap-2 ${s.state === "todo" ? "text-zinc-400" : "text-zinc-900"}`}>
            {s.state === "current" ? <Spinner className="text-blue-600" /> : s.state === "done" ? <span aria-hidden>✓</span> : <span aria-hidden>○</span>}
            {s.label}
          </li>
        ))}
      </ol>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-blue-100" role="progressbar" aria-busy={!known}>
        {known ? (
          <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${(100 * activity.renderedFrames!) / activity.totalFrames!}%` }} />
        ) : (
          <div className="progress-indeterminate h-full w-1/3 bg-blue-600" />
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-600 tabular">
        {known
          ? `Renderizando ${activity.renderedFrames} / ${activity.totalFrames} frames`
          : activity.phase === "generating"
            ? "Preparando assets (vídeo IA e áudio simulados)…"
            : "Iniciando o render (o primeiro render do processo empacota a composição e pode demorar mais)…"}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-medium tabular">{value}</dd>
    </div>
  );
}
