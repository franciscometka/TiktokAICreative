"use client";

import Link from "next/link";
import { useState, useTransition, type ComponentType } from "react";
import type { ImageView } from "@/application/campaign-view";
import type { CreateV2Input, V2EstimateView } from "@/application/create-v2";
import type { UserError } from "@/application/user-errors";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import { UGC_ENVIRONMENTS } from "@/domain/ugc";
import { formatBrl } from "@/lib/money";
import { cx, Spinner } from "../ui/primitives";
import { Card, FieldError, FieldLabel, Segmented, v2Button, v2Input } from "./ui";

/**
 * Criar vídeo (UX V2). Obrigatório: foto + nome, ideia, avatar (Automático por padrão) e duração.
 * "Personalizar" e "Configurações avançadas" ficam recolhidos; o usuário normal não precisa abrir.
 * Presentacional: a ação de servidor e o uploader são injetados (testável sem Next).
 */

export interface AvatarOption { id: string; name: string; imageUrl: string | null; tags: string[] }

export interface UploaderProps { productId: string; images: ImageView[]; onChange: (images: ImageView[]) => void; error?: string; hint?: string }

export type SubmitResult = { ok: true; value: { campaignId: string } } | { ok: false; error: UserError; fieldErrors?: Partial<Record<string, string>> };

export interface CreateVideoFormProps {
  productId: string;
  avatars: AvatarOption[];
  estimates: V2EstimateView[];
  planningAvailable: boolean;
  compact?: boolean;
  Uploader: ComponentType<UploaderProps>;
  submit: (input: CreateV2Input) => Promise<SubmitResult>;
  onCreated: (campaignId: string) => void;
}

const DURATIONS = [{ value: 30, label: "30s" }, { value: 45, label: "45s" }, { value: 60, label: "60s" }] as const;
const QUALITIES = [{ value: "economy", label: "Econômico" }, { value: "high", label: "Equilibrado" }, { value: "premium", label: "Premium" }] as const;

export function CreateVideoForm({ productId, avatars, estimates, planningAvailable, compact, Uploader, submit, onCreated }: CreateVideoFormProps) {
  const [images, setImages] = useState<ImageView[]>([]);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [avatar, setAvatar] = useState<string>("auto");
  const [duration, setDuration] = useState<30 | 45 | 60>(30);
  const [gender, setGender] = useState<"auto" | "woman" | "man">("auto");
  const [environment, setEnvironment] = useState<string>("auto");
  const [tone, setTone] = useState("");
  const [cta, setCta] = useState("");
  const [quality, setQuality] = useState<"economy" | "high" | "premium">("high");
  const [voiceLock, setVoiceLock] = useState<"auto" | "locked" | "native">("auto");
  const [showCost, setShowCost] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [failure, setFailure] = useState<UserError | null>(null);
  const [pending, startTransition] = useTransition();

  const estimate = estimates.find((e) => e.duration === duration && e.quality === quality);

  function generate() {
    setFailure(null);
    const local: Partial<Record<string, string>> = {};
    if (images.length === 0) local.imageIds = "Envie ao menos uma foto do produto.";
    if (!name.trim()) local.name = "Informe o nome do produto.";
    if (idea.trim().length < 3) local.idea = "Conte em poucas palavras o que você quer criar.";
    setErrors(local);
    if (Object.keys(local).length) return;
    startTransition(async () => {
      const result = await submit({
        productId, name, imageIds: images.map((i) => i.id), idea, avatar, duration, style: "ugc_natural",
        personalize: {
          ...(avatar === "auto" && gender !== "auto" ? { gender } : {}),
          ...(environment !== "auto" ? { environment: environment as (typeof UGC_ENVIRONMENTS)[number] } : {}),
          ...(tone.trim() ? { tone } : {}), ...(cta.trim() ? { cta } : {}),
        },
        advanced: { quality, voiceLock },
      });
      if (result.ok) onCreated(result.value.campaignId);
      else { setFailure(result.error); setErrors(result.fieldErrors ?? {}); }
    });
  }

  return (
    <Card className={cx("p-5 sm:p-7", compact && "sm:p-6")}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div>
          <FieldLabel>Produto</FieldLabel>
          <Uploader productId={productId} images={images} onChange={(next) => { setImages(next); setErrors((e) => ({ ...e, imageIds: undefined })); }} error={errors.imageIds} hint="Fotos reais do produto (JPG, PNG ou WebP)." />
          <input id="v2-name" aria-label="Nome do produto" className={cx(v2Input(!!errors.name), "mt-3")} placeholder="Nome do produto" maxLength={120} value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }} />
          <FieldError>{errors.name}</FieldError>
        </div>
        <div className="min-w-0">
          <FieldLabel htmlFor="v2-idea">O que você quer criar?</FieldLabel>
          <textarea id="v2-idea" rows={compact ? 4 : 5} maxLength={2000} className={cx(v2Input(!!errors.idea), "resize-none text-base leading-relaxed")}
            placeholder="Uma mulher apresentando este secador de forma natural em um quarto." value={idea} onChange={(e) => { setIdea(e.target.value); setErrors((x) => ({ ...x, idea: undefined })); }} />
          <FieldError>{errors.idea}</FieldError>

          <div className="mt-5 flex flex-wrap items-end gap-x-6 gap-y-4">
            <div>
              <FieldLabel htmlFor="v2-avatar">Avatar</FieldLabel>
              <select id="v2-avatar" className={cx(v2Input(), "min-w-48 py-2.5")} value={avatar} onChange={(e) => setAvatar(e.target.value)}>
                <option value="auto">Automático</option>
                {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <Link href="/avatars/new" className="mt-1.5 block text-xs font-medium text-indigo-600 hover:text-indigo-500">+ Criar novo avatar</Link>
              <SelectedAvatar avatar={avatars.find((a) => a.id === avatar)} />
            </div>
            <div>
              <FieldLabel>Duração</FieldLabel>
              <Segmented label="Duração" options={DURATIONS} value={duration} onChange={setDuration} />
            </div>
            <div>
              <FieldLabel htmlFor="v2-style">Estilo</FieldLabel>
              <select id="v2-style" className={cx(v2Input(), "min-w-40 py-2.5")} value="ugc_natural" onChange={() => undefined}>
                <option value="ugc_natural">UGC Natural</option>
              </select>
            </div>
          </div>

          <details className="group mt-6 rounded-xl border border-zinc-100 bg-zinc-50/60 px-4 py-3" data-section="personalize">
            <summary className="cursor-pointer text-sm font-medium text-zinc-700">Personalizar</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {avatar === "auto" && <label className="text-sm text-zinc-700">Gênero
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
                  <option value="auto">Automático</option><option value="woman">Mulher</option><option value="man">Homem</option>
                </select></label>}
              <label className="text-sm text-zinc-700">Ambiente
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                  <option value="auto">Automático</option>
                  {UGC_ENVIRONMENTS.map((id) => <option key={id} value={id}>{UGC_ENVIRONMENT_LABELS[id].label}</option>)}
                </select></label>
              <label className="text-sm text-zinc-700">Tom
                <input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={120} placeholder="Natural e simpático" value={tone} onChange={(e) => setTone(e.target.value)} /></label>
              <label className="text-sm text-zinc-700">CTA
                <input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={200} placeholder="Dá uma olhada no carrinho" value={cta} onChange={(e) => setCta(e.target.value)} /></label>
            </div>
          </details>

          <details className="mt-3 rounded-xl border border-zinc-100 px-4 py-3" data-section="advanced">
            <summary className="cursor-pointer text-sm font-medium text-zinc-500">Configurações avançadas</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-zinc-700">Qualidade (preset interno)
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
                  {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select></label>
              <label className="text-sm text-zinc-700">Voz
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={voiceLock} onChange={(e) => setVoiceLock(e.target.value as typeof voiceLock)}>
                  <option value="auto">Voice Lock quando o provider suportar</option>
                  <option value="locked">Exigir Voice Lock</option>
                  <option value="native">Voz do próprio vídeo</option>
                </select></label>
              <p className="text-xs leading-relaxed text-zinc-500 sm:col-span-2">
                {estimate ? `${estimate.clips} trechos de até 8s gerados · teto do job e aprovações continuam valendo.` : ""} Provider, modelo, resolução e diagnóstico ficam em Configurações → Avançado. <Link className="font-medium text-zinc-700 underline" href="/create?mode=advanced">Criação avançada</Link>
              </p>
            </div>
          </details>
        </div>
      </div>

      <div className="mt-7 flex flex-col-reverse gap-4 border-t border-zinc-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-zinc-600">
          {estimate ? <p><span className="font-medium text-zinc-900 tabular">Estimativa: {formatBrl(estimate.totalBrl)}</span>{estimate.provisional ? " · provisória" : ""} <button type="button" className="ml-2 text-xs font-medium text-indigo-600 hover:text-indigo-500" onClick={() => setShowCost((v) => !v)} aria-expanded={showCost}>Ver detalhes</button></p> : null}
          {showCost && estimate ? <ul className="mt-2 space-y-0.5 text-xs text-zinc-500 tabular" aria-label="Detalhes da estimativa">{estimate.lines.map((l) => <li key={l.label}>{l.label}: {formatBrl(l.brl)}</li>)}</ul> : null}
        </div>
        <button type="button" className={v2Button("primary", "lg")} onClick={generate} disabled={pending || !planningAvailable}>
          {pending && <Spinner />}{pending ? "Preparando…" : "Gerar vídeo"}
        </button>
      </div>
      {failure ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800"><span className="font-medium">{failure.title}.</span> {failure.message}</p> : null}
      {!planningAvailable ? <p className="mt-4 text-sm text-amber-800">A geração ainda não está configurada neste servidor. Veja Configurações → Avançado.</p> : null}
    </Card>
  );
}

/**
 * Correção Lote 6: avatar salvo escolhido → a FOTO real dele aparece aqui (é ela que vai ao
 * provider). Sem foto, o aviso é explícito: a aparência vem da descrição e pode variar.
 */
export function SelectedAvatar({ avatar }: { avatar: AvatarOption | undefined }) {
  if (!avatar) return null;
  return avatar.imageUrl ? (
    <div className="mt-2 flex items-center gap-2 text-xs text-zinc-600" data-testid="selected-avatar">
      {/* eslint-disable-next-line @next/next/no-img-element -- foto do avatar servida por rota com IDs */}
      <img src={avatar.imageUrl} alt={`Foto do avatar ${avatar.name}`} className="size-10 rounded-lg object-cover" />
      <span>{avatar.name} desta foto apresenta o vídeo.</span>
    </div>
  ) : (
    <p className="mt-2 max-w-56 text-xs text-amber-700" data-testid="selected-avatar">{avatar.name} não tem foto: a aparência virá da descrição e pode variar. Adicione uma foto em Avatares.</p>
  );
}
