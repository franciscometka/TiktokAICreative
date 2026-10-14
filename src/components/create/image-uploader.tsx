"use client";

import { useRef, useState } from "react";
import { removeImageAction } from "@/app/actions";
import type { ActionResult, UploadedImageView } from "@/application/campaign-actions";
import type { ImageView } from "@/application/campaign-view";
import { IMAGE_TYPES, UPLOAD_ERROR_MESSAGES, UPLOAD_LIMITS, isImageContentType } from "@/domain/upload";
import { buttonClasses, cx, Spinner } from "../ui/primitives";

const ACCEPT = Object.keys(IMAGE_TYPES).join(",");
const MB = 1024 * 1024;

/**
 * Upload local das imagens do produto. A checagem aqui é só conveniência; o servidor valida
 * MIME, tamanho e o conteúdo real do arquivo de novo.
 */
export function ImageUploader({
  productId,
  images,
  onChange,
  error,
}: {
  productId: string;
  images: ImageView[];
  onChange: (images: ImageView[]) => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [messages, setMessages] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const remaining = UPLOAD_LIMITS.maxImagesPerProduct - images.length;

  async function upload(files: File[]) {
    const problems: string[] = [];
    const accepted = files.filter((file) => {
      if (!isImageContentType(file.type)) problems.push(`${file.name}: ${UPLOAD_ERROR_MESSAGES.unsupported_type}`);
      else if (file.size > UPLOAD_LIMITS.maxBytes) problems.push(`${file.name}: ${UPLOAD_ERROR_MESSAGES.too_large}`);
      else return true;
      return false;
    });
    if (accepted.length > remaining) {
      problems.push(UPLOAD_ERROR_MESSAGES.limit_reached);
      accepted.splice(remaining);
    }

    let current = images;
    setUploading(accepted.length);
    for (const file of accepted) {
      const body = new FormData();
      body.set("file", file);
      body.set("productId", productId);
      try {
        const response = await fetch("/api/uploads", { method: "POST", body });
        const result = (await response.json()) as ActionResult<UploadedImageView>;
        if (result.ok) {
          current = [...current, { id: result.value.id, previewUrl: result.value.previewUrl }];
          onChange(current);
        } else {
          problems.push(`${file.name}: ${result.error.message}`);
        }
      } catch {
        problems.push(`${file.name}: falha no envio.`);
      }
      setUploading((n) => n - 1);
    }
    setMessages(problems);
  }

  async function remove(imageId: string) {
    setRemoving(imageId);
    const result = await removeImageAction({ productId, imageId });
    setRemoving(null);
    if (result.ok) onChange(images.filter((i) => i.id !== imageId));
    else setMessages([result.error.message]);
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {images.map((image, i) => (
          <figure key={image.id} className="group relative aspect-square overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">
            {/* eslint-disable-next-line @next/next/no-img-element -- imagem local servida por /api/uploads */}
            <img src={image.previewUrl} alt={`Imagem ${i + 1} do produto`} className="size-full object-cover" />
            <button
              type="button"
              onClick={() => remove(image.id)}
              disabled={removing === image.id}
              className="absolute top-1 right-1 rounded bg-white/95 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 shadow-sm ring-1 ring-zinc-200 hover:text-red-700"
              aria-label={`Remover imagem ${i + 1}`}
            >
              {removing === image.id ? "…" : "Remover"}
            </button>
          </figure>
        ))}
        {Array.from({ length: uploading }, (_, i) => (
          <div key={`up-${i}`} className="grid aspect-square place-items-center rounded-md border border-dashed border-zinc-300 bg-zinc-50">
            <Spinner className="text-zinc-400" />
          </div>
        ))}
        {remaining - uploading > 0 && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cx(
              "grid aspect-square place-items-center rounded-md border border-dashed bg-white text-center text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700",
              error ? "border-red-300" : "border-zinc-300",
            )}
          >
            <span>
              <span className="block text-lg leading-none text-zinc-400">+</span>
              Adicionar
            </span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void upload(files);
        }}
      />
      <p className="mt-2 text-xs text-zinc-500">
        JPG, PNG ou WebP · até {UPLOAD_LIMITS.maxBytes / MB} MB cada · até {UPLOAD_LIMITS.maxImagesPerProduct} imagens. Fotos reais
        do produto reduzem os segundos de vídeo IA necessários.
      </p>
      {images.length === 0 && remaining > 0 && (
        <button type="button" className={cx(buttonClasses("secondary", "sm"), "mt-2 sm:hidden")} onClick={() => inputRef.current?.click()}>
          Enviar imagens
        </button>
      )}
      {(messages.length > 0 || error) && (
        <ul className="mt-2 space-y-0.5 text-xs font-medium text-red-600">
          {error && <li>{error}</li>}
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
