import type { GenerationPreview } from "@/application/generation-view";
import { cx, Skeleton, Spark } from "../ds";

/**
 * L8.5 — prévia 9:16. Vídeo final > cena pronta > skeleton. Um ÚNICO <video> por vez, sem
 * autoplay, `preload="metadata"`; `key` = URL para o player não recriar a cada poll (só quando a
 * mídia muda de fato). Nada de player vazio quebrado.
 */
export function PreviewPlayer({ preview, title, active }: { preview: GenerationPreview; title: string; active: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[14rem] sm:max-w-[20rem]" data-preview={preview.kind}>
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-surface-sunken ring-1 ring-line shadow-raise">
        {preview.kind === "none" ? (
          <>
            <Skeleton className="absolute inset-0" rounded="xl" />
            <div className="absolute inset-0 grid place-items-center">
              <span className="flex flex-col items-center gap-2 text-center text-caption text-fg-subtle">
                <Spark active={active} gradient className="text-2xl" />
                {active ? "A prévia aparece quando a primeira cena ficar pronta." : "Sem prévia ainda."}
              </span>
            </div>
          </>
        ) : (
          <video key={preview.url} src={preview.url} controls playsInline preload="metadata"
            aria-label={preview.kind === "final" ? `Vídeo final: ${title}` : `Prévia da cena ${preview.sceneNumber}`}
            className="size-full animate-reveal bg-black object-contain" />
        )}
        {preview.kind === "scene" ? (
          <span className={cx("pointer-events-none absolute top-2 left-2 rounded-full bg-canvas/85 px-2.5 py-1 text-caption font-medium text-fg")}>Cena {preview.sceneNumber}</span>
        ) : null}
      </div>
    </div>
  );
}
