"use client";

import { Check, ImagePlus, Plus, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { removeImageAction } from "@/app/actions";
import type { ImageView } from "@/application/campaign-view";
import { cx, focusRing, IconButton, interactive, Skeleton, Spinner } from "../ds";
import { IMAGE_ACCEPT, MAX_IMAGE_MB, screenFiles, uploadProductImage } from "./upload-client";

/**
 * L8.3 — foto do produto no estilo Cinematic AI Studio (Home e Create usam o MESMO componente).
 * Estados: idle · hover (CSS) · drag · uploading · success · error. Clique, teclado (Enter/Espaço
 * no botão) e arrastar-e-soltar. Durante o envio: skeleton + texto, SEM porcentagem (o envio
 * direto ao Storage não informa progresso real). Erros e conclusão são anunciados por aria-live.
 */

export type PhotoDropState = "idle" | "drag" | "uploading" | "success" | "error";

export interface PhotoDropViewProps {
  state: PhotoDropState;
  images: ImageView[];
  max: number;
  /** Texto do aria-live (erro, envio, conclusão). */
  message?: string | undefined;
  size?: "tile" | "panel";
  disabled?: boolean;
  onPick?: () => void;
  onRemove?: (imageId: string) => void;
  removing?: string | null;
  drag?: { onDragEnter: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  /** Rótulo do bloco e alt da foto (padrão: produto; o avatar usa o seu). */
  label?: string;
}

/** Apresentacional (testável sem browser): todo estado vem por props. */
export function PhotoDropView({ state, images, max, message, size = "panel", disabled, onPick, onRemove, removing, drag, label = "Foto do produto" }: PhotoDropViewProps) {
  const main = images[0];
  const extra = images.slice(1);
  const canAdd = images.length < max && state !== "uploading";
  const tile = size === "tile";
  return (
    <div data-photo-state={state} className={cx(tile ? "w-full" : "w-full max-w-xs")} {...drag}>
      {main ? (
        <figure className={cx("relative overflow-hidden rounded-2xl bg-surface-sunken ring-1 ring-line", tile ? "aspect-square" : "aspect-[4/3] sm:aspect-[4/5]")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- imagem do upload servida por rota com IDs */}
          <img key={main.id} src={main.previewUrl} alt={label} className="size-full animate-reveal object-cover" />
          <span className="absolute bottom-2 left-2 inline-flex h-6 animate-fade-in items-center gap-1 rounded-full bg-canvas/80 px-2 text-xs font-medium text-success ring-1 ring-success/30 backdrop-blur-sm">
            <Check className="size-3.5" aria-hidden strokeWidth={2.5} />Imagem pronta
          </span>
          {onRemove ? (
            <IconButton label="Remover foto" size="sm" variant="secondary" disabled={removing === main.id} onClick={() => onRemove(main.id)}
              className="absolute top-2 right-2 bg-canvas/80 backdrop-blur-sm">
              {removing === main.id ? <Spinner /> : <X />}
            </IconButton>
          ) : null}
        </figure>
      ) : (
        <button type="button" onClick={onPick} disabled={disabled || state === "uploading"}
          className={cx(
            "group relative grid w-full place-items-center overflow-hidden rounded-2xl border border-dashed text-center", interactive, focusRing,
            tile ? "aspect-square" : "aspect-[4/3] sm:aspect-[4/5]",
            state === "drag" ? "border-primary-light bg-primary-soft" : state === "error" ? "border-danger/60 bg-danger-soft/40" : "border-line-strong bg-surface-sunken hover:border-primary-light/60 hover:bg-surface",
            "disabled:cursor-wait",
          )}>
          {state === "uploading" ? (
            <>
              <Skeleton className="absolute inset-0" rounded="xl" />
              <span className="relative flex items-center gap-2 text-caption font-medium text-fg-muted"><Spinner />Enviando foto…</span>
            </>
          ) : (
            <span className="flex flex-col items-center gap-2 px-3">
              <span className={cx("grid size-10 place-items-center rounded-xl ring-1 ring-inset", interactive, state === "drag" ? "bg-primary text-on-primary ring-primary" : "bg-surface text-primary-light ring-line group-hover:ring-primary/40")}>
                <ImagePlus className="size-5" aria-hidden />
              </span>
              <span className="text-sm font-medium text-fg">{state === "drag" ? "Solte para enviar" : label}</span>
              {tile ? null : <span className="text-caption text-fg-subtle">Arraste aqui ou clique · JPG, PNG ou WebP · até {MAX_IMAGE_MB} MB</span>}
            </span>
          )}
        </button>
      )}

      {max > 1 && (main || extra.length > 0) ? (
        <ul className="mt-2 grid grid-cols-5 gap-1.5" aria-label="Outras fotos do produto">
          {extra.map((image, i) => (
            <li key={image.id} className="group relative aspect-square overflow-hidden rounded-lg ring-1 ring-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- imagem do upload servida por rota com IDs */}
              <img src={image.previewUrl} alt={`Foto ${i + 2} do produto`} className="size-full animate-reveal object-cover" />
              {onRemove ? (
                <button type="button" aria-label={`Remover foto ${i + 2}`} onClick={() => onRemove(image.id)} disabled={removing === image.id}
                  className={cx("absolute inset-0 grid place-items-center bg-canvas/70 text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100", interactive, focusRing)}>
                  <X className="size-4" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
          {state === "uploading" ? <li><Skeleton className="aspect-square" /></li> : null}
          {canAdd ? (
            <li>
              <button type="button" onClick={onPick} aria-label="Adicionar outra foto" disabled={disabled}
                className={cx("grid aspect-square w-full place-items-center rounded-lg border border-dashed border-line-strong text-fg-subtle hover:border-primary-light/60 hover:text-fg", interactive, focusRing)}>
                <Plus className="size-4" aria-hidden />
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* Envio e conclusão já aparecem no próprio bloco: só o erro ocupa espaço visível. */}
      <p aria-live="polite" role="status" className={cx("text-caption", state === "error" && message ? "mt-2 font-medium text-danger" : "sr-only")}>
        {message}
      </p>
    </div>
  );
}

/** Container: estado, envio (camada compartilhada), arrastar-e-soltar e remoção. */
export function PhotoDrop({ productId, images, onChange, max = 1, error, size, disabled, label }: {
  productId: string;
  images: ImageView[];
  onChange: (images: ImageView[]) => void;
  max?: number;
  /** Erro de validação de quem usa (ex.: "Envie ao menos uma foto"). */
  error?: string | undefined;
  size?: "tile" | "panel";
  disabled?: boolean;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function upload(files: File[]) {
    const screened = screenFiles(files, max - images.length);
    const accepted = screened.accepted.map((i) => files[i]!);
    const problems = [...screened.problems];
    setProblem(null);
    setAnnounce(null);
    if (accepted.length > 0) setUploading(true);
    let current = images;
    for (const file of accepted) {
      const result = await uploadProductImage(productId, file);
      if (result.ok) {
        current = [...current, { id: result.value.id, previewUrl: result.value.previewUrl }];
        onChange(current);
      } else problems.push(`${file.name}: ${result.error.message}`);
    }
    setUploading(false);
    if (problems.length > 0) setProblem(problems.join(" "));
    else if (accepted.length > 0) setAnnounce(accepted.length === 1 ? "Foto enviada." : `${accepted.length} fotos enviadas.`);
  }

  async function remove(imageId: string) {
    setRemoving(imageId);
    const result = await removeImageAction({ productId, imageId });
    setRemoving(null);
    if (result.ok) { onChange(images.filter((i) => i.id !== imageId)); setAnnounce("Foto removida."); }
    else setProblem(result.error.message);
  }

  const shown = problem ?? error ?? null;
  const state: PhotoDropState = uploading ? "uploading" : dragging ? "drag" : shown ? "error" : images.length > 0 ? "success" : "idle";
  const message = uploading ? "Enviando foto…" : shown ?? announce ?? undefined;

  return (
    <>
      <PhotoDropView state={state} images={images} max={max} message={message} size={size} disabled={disabled} removing={removing} {...(label ? { label } : {})}
        onPick={() => inputRef.current?.click()} onRemove={(id) => void remove(id)}
        drag={{
          onDragEnter: (e) => { e.preventDefault(); depth.current += 1; if (images.length < max) setDragging(true); },
          onDragOver: (e) => { e.preventDefault(); },
          onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); },
          onDrop: (e) => {
            e.preventDefault();
            depth.current = 0;
            setDragging(false);
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length > 0 && !uploading) void upload(files);
          },
        }} />
      <input ref={inputRef} type="file" accept={IMAGE_ACCEPT} multiple={max > 1} className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void upload(files);
        }} />
    </>
  );
}
