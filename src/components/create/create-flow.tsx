"use client";

import { ArrowLeft, ArrowRight, Check, Pencil, SlidersHorizontal, UserRoundPlus } from "lucide-react";
import Link from "next/link";
import { useReducer, useRef, useState, useTransition, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import {
  autoAvatarPreview, CREATE_STEPS, createFlowReducer, creditsReview, firstInvalidStep, QUALITY_OPTIONS, qualityLabel, toCreateInput,
  type AvatarChoice, type CreateDraft, type CreateFlowAction, type CreateFlowState, type CreateStep, type CreditsReview,
} from "@/application/create-flow";
import type { CreateV2Input, V2EstimateView } from "@/application/create-v2";
import { STYLE_PRESETS, stylePreset } from "@/application/style-presets";
import type { UserError } from "@/application/user-errors";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import { formatCredits } from "@/costs/credits";
import { UGC_ENVIRONMENTS } from "@/domain/ugc";
import { Badge, Button, Card, cx, Field, focusRing, Input, interactive, Segmented, Select, Sheet, Spark, Textarea } from "../ds";
import { PhotoDrop } from "../upload/photo-drop";
import type { SubmitResult } from "../v2/create-video-form";

/**
 * L8.4 — Criar vídeo em 4 passos (Cinematic AI Studio). Rascunho único no reducer de
 * `application/create-flow`. O botão final chama a MESMA Server Action do Create antigo
 * (`startVideoV2Action`, injetada): criar projeto não autoriza gasto — o projeto abre esperando
 * a aprovação explícita existente. Créditos (L8.2): estimativa sempre "~N".
 */

export type UploaderComponent = ComponentType<{ productId: string; images: CreateDraft["images"]; onChange: (images: CreateDraft["images"]) => void; error?: string; max?: number }>;

export interface CreateFlowProps {
  initial: CreateFlowState;
  avatars: AvatarChoice[];
  estimates: V2EstimateView[];
  /** null = créditos não configurados ("Créditos indisponíveis", nunca saldo inventado). */
  credits: { perBrl: number; remaining: number } | null;
  planningAvailable: boolean;
  submit: (input: CreateV2Input) => Promise<SubmitResult>;
  onCreated: (campaignId: string) => void;
  Uploader?: UploaderComponent;
}

const DURATIONS = [{ value: 30, label: "30s" }, { value: 45, label: "45s" }, { value: 60, label: "60s" }] as const;
const MAX_PHOTOS = 6;

export function CreateFlow({ initial, avatars, estimates, credits, planningAvailable, submit, onCreated, Uploader = PhotoDrop }: CreateFlowProps) {
  const [state, dispatch] = useReducer(createFlowReducer, initial);
  const [failure, setFailure] = useState<UserError | null>(null);
  const [personalizeOpen, setPersonalizeOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const { step, draft, errors } = state;
  const review = creditsReview({ estimates, duration: draft.duration, quality: draft.quality, credits });
  const set = (patch: Partial<CreateDraft>) => dispatch({ type: "set", patch });

  function create() {
    setFailure(null);
    const invalid = firstInvalidStep(draft);
    if (invalid) { dispatch({ type: "goto", step: invalid }); return; }
    startTransition(async () => {
      const result = await submit(toCreateInput(draft));
      if (result.ok) onCreated(result.value.campaignId);
      else { setFailure(result.error); if (result.fieldErrors) dispatch({ type: "serverErrors", errors: result.fieldErrors }); }
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pt-8 pb-12 sm:px-8 sm:pt-12" data-create-step={step}>
      <header>
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-title">Criar vídeo</h1>
        <p className="mt-2 text-body text-fg-muted">Foto, avatar e estilo. A gente cuida do roteiro, da apresentadora e da edição.</p>
      </header>

      <Stepper step={step} dispatch={dispatch} />

      <Card padding="none" className="mt-6 p-5 sm:p-7">
        <div key={step} className="animate-fade-up">
          {step === "product" ? <ProductStep draft={draft} errors={errors} set={set} Uploader={Uploader} /> : null}
          {step === "avatar" ? <AvatarStep draft={draft} avatars={avatars} set={set} error={errors.avatar} /> : null}
          {step === "style" ? <StyleStep draft={draft} dispatch={dispatch} review={review} onPersonalize={() => setPersonalizeOpen(true)} /> : null}
          {step === "review" ? <ReviewStep draft={draft} avatars={avatars} review={review} dispatch={dispatch} creditsConfigured={credits !== null} /> : null}
        </div>

        {failure ? (
          <p role="alert" className="mt-6 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-inset ring-danger/25">
            <span className="font-medium">{failure.title}.</span> <span className="text-fg-muted">{failure.message}</span>
          </p>
        ) : null}
        {!planningAvailable && step === "review" ? (
          <p className="mt-6 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning ring-1 ring-inset ring-warning/25">A geração ainda não está configurada neste servidor. Veja Configurações → Avançado.</p>
        ) : null}

        <div className="mt-7 flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          {step === "product"
            ? <Link href="/create?mode=advanced" className={cx("text-center text-caption font-medium text-fg-subtle hover:text-fg sm:text-left", interactive, focusRing)}>Modo avançado</Link>
            : <Button variant="ghost" icon={<ArrowLeft />} onClick={() => dispatch({ type: "back" })} disabled={pending}>Voltar</Button>}
          {step === "review" ? (
            <Button variant="ai" size="lg" onClick={create} loading={pending} disabled={!planningAvailable} data-create-cta>
              {pending ? null : <Spark inherit />}{pending ? "Criando projeto…" : review ? `Criar projeto · ~${formatCredits(review.estimated)} créditos` : "Criar projeto"}
            </Button>
          ) : (
            <Button size="lg" trailingIcon={<ArrowRight />} onClick={() => dispatch({ type: "next" })}>Continuar</Button>
          )}
        </div>
        {step === "review" ? <p className="mt-3 text-center text-caption text-fg-subtle sm:text-right">Criar o projeto não gera custo: a geração só começa com a sua aprovação.</p> : null}
      </Card>

      <PersonalizeSheet open={personalizeOpen} onClose={() => setPersonalizeOpen(false)} draft={draft} set={set} />
    </main>
  );
}

// ---------------------------------------------------------------- stepper

function Stepper({ step, dispatch }: { step: CreateStep; dispatch: (a: CreateFlowAction) => void }) {
  const current = CREATE_STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="mt-7 grid grid-cols-4 gap-2" aria-label="Etapas">
      {CREATE_STEPS.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "pending";
        return (
          <li key={s.id} className="min-w-0">
            <button type="button" onClick={() => dispatch({ type: "goto", step: s.id })} aria-current={state === "current" ? "step" : undefined}
              className={cx("group w-full rounded-lg text-left", focusRing)}>
              <span className={cx("block h-[3px] rounded-full transition-colors duration-(--dur-normal)", state === "pending" ? "bg-fg/10" : "bg-primary-light")} />
              <span className={cx("mt-2 flex items-center gap-1.5 text-caption font-medium", state === "pending" ? "text-fg-subtle" : "text-fg")}>
                <span className={cx("tabular", state === "current" ? "text-primary-light" : "text-fg-subtle")}>{state === "done" ? <Check className="size-3.5 text-primary-light" aria-label="Concluída" /> : s.number}</span>
                <span className="truncate">{s.label}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepTitle({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 01 Produto

function ProductStep({ draft, errors, set, Uploader }: { draft: CreateDraft; errors: CreateFlowState["errors"]; set: (p: Partial<CreateDraft>) => void; Uploader: UploaderComponent }) {
  return (
    <div>
      <StepTitle title="Produto" description="Fotos reais do produto deixam o vídeo fiel ao que você vende." />
      <div className="grid gap-6 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div>
          <p className="mb-2 text-sm font-medium text-fg">Foto</p>
          <Uploader productId={draft.productId} images={draft.images} onChange={(images) => set({ images })} error={errors.images} max={MAX_PHOTOS} />
        </div>
        <div className="min-w-0 space-y-5">
          <Field label="Nome do produto" error={errors.name}>
            <Input value={draft.name} maxLength={120} placeholder="Ex.: Secador Taiff 2100W" onChange={(e) => set({ name: e.target.value })} inputSize="lg" />
          </Field>
          <Field label="O que você quer criar?" error={errors.idea}>
            <Textarea rows={5} maxLength={2000} value={draft.idea} placeholder="Uma mulher apresentando este secador de forma natural em um quarto." onChange={(e) => set({ idea: e.target.value })} />
          </Field>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 02 Avatar

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "•";
}

export function AvatarStep({ draft, avatars, set, error }: { draft: CreateDraft; avatars: AvatarChoice[]; set: (p: Partial<CreateDraft>) => void; error?: string }) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const ids = ["auto", ...avatars.map((a) => a.id)];
  const index = Math.max(0, ids.indexOf(draft.avatar));
  const auto = autoAvatarPreview(avatars, { name: draft.name, idea: draft.idea });

  function onKeyDown(event: KeyboardEvent) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : delta ? (index + delta + ids.length) % ids.length : -1;
    if (target < 0) return;
    event.preventDefault();
    set({ avatar: ids[target]! });
    refs.current[target]?.focus();
  }

  const option = (i: number, selected: boolean, children: ReactNode, label: string) => (
    <div key={ids[i]} ref={(el) => { refs.current[i] = el; }} role="radio" aria-checked={selected} aria-label={label} tabIndex={i === index ? 0 : -1}
      onClick={() => set({ avatar: ids[i]! })} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); set({ avatar: ids[i]! }); } }}
      className={cx("relative flex min-w-0 cursor-pointer flex-col rounded-2xl border p-3", interactive, focusRing,
        selected ? "border-primary-light/60 bg-primary-soft ring-1 ring-primary-light/40" : "border-line bg-surface-sunken hover:border-line-strong hover:bg-surface-hover")}>
      {selected ? <span className="absolute top-2.5 right-2.5 grid size-5 animate-scale-in place-items-center rounded-full bg-primary text-on-primary"><Check className="size-3" strokeWidth={3} aria-hidden /></span> : null}
      {children}
    </div>
  );

  return (
    <div>
      <StepTitle title="Avatar" description="Quem apresenta o seu produto." />
      <div role="radiogroup" aria-label="Avatar" onKeyDown={onKeyDown} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {option(0, draft.avatar === "auto", (
          <>
            <span className="grid aspect-square w-full place-items-center rounded-xl bg-(image:--cf-gradient-ai) text-3xl text-on-primary"><Spark inherit /></span>
            <span className="mt-3 text-sm font-medium text-fg">Escolha automática</span>
            <span className="mt-1 line-clamp-3 text-caption text-fg-muted" data-auto-preview>{auto.avatar ? `Provável: ${auto.avatar.name}${auto.detail ? ` · ${auto.detail}` : ""}` : "Escolhemos o avatar que combina com o produto ou geramos uma apresentadora."}</span>
          </>
        ), "Escolha automática")}
        {avatars.map((a, i) => option(i + 1, draft.avatar === a.id, (
          <>
            {a.imageUrl
              // eslint-disable-next-line @next/next/no-img-element -- foto do avatar servida por rota com IDs
              ? <img src={a.imageUrl} alt="" loading="lazy" className="aspect-square w-full rounded-xl object-cover" />
              : <span aria-hidden className="grid aspect-square w-full place-items-center rounded-xl bg-surface text-2xl font-semibold text-fg-muted ring-1 ring-inset ring-line">{initials(a.name)}</span>}
            <span className="mt-3 truncate text-sm font-medium text-fg">{a.name}</span>
            {a.voiceName ? <span className="truncate text-caption text-fg-subtle">Voz: {a.voiceName}</span> : null}
            {a.defaultForTags.length ? <span className="mt-1 truncate text-caption text-primary-light">Padrão para {a.defaultForTags.slice(0, 2).join(", ")}</span> : null}
            {a.tags.length ? <span className="mt-2 flex flex-wrap gap-1">{a.tags.slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}</span> : null}
            {a.imageUrl ? null : <span className="mt-2 text-caption text-warning">Sem foto: a aparência vem da descrição.</span>}
          </>
        ), a.name))}
      </div>
      {error ? <p role="alert" className="mt-3 text-caption font-medium text-danger">{error}</p> : null}
      <Link href="/avatars/new" className={cx("mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary-light hover:text-fg", interactive, focusRing)}><UserRoundPlus className="size-4" aria-hidden />Criar novo avatar</Link>
    </div>
  );
}

// ---------------------------------------------------------------- 03 Estilo

function StyleStep({ draft, dispatch, review, onPersonalize }: { draft: CreateDraft; dispatch: (a: CreateFlowAction) => void; review: CreditsReview | null; onPersonalize: () => void }) {
  return (
    <div>
      <StepTitle title="Estilo" description="O preset preenche tom, chamada final e duração. Você pode ajustar tudo em Personalizar." />
      <div role="radiogroup" aria-label="Estilo" className="grid gap-3 sm:grid-cols-2">
        {STYLE_PRESETS.map((p) => {
          const selected = draft.preset === p.id;
          return (
            <button key={p.id} type="button" role="radio" aria-checked={selected} onClick={() => dispatch({ type: "preset", id: p.id })}
              className={cx("relative rounded-2xl border p-4 text-left", interactive, focusRing,
                selected ? "border-primary-light/60 bg-primary-soft ring-1 ring-primary-light/40" : "border-line bg-surface-sunken hover:border-line-strong hover:bg-surface-hover")}>
              <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-fg">{p.label}</span><span className="text-caption text-fg-subtle tabular">{p.duration}s</span></span>
              <span className="mt-1 block text-caption text-fg-muted">{p.description}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-fg">Duração</p>
          <Segmented label="Duração" options={DURATIONS} value={draft.duration} onChange={(duration) => dispatch({ type: "set", patch: { duration } })} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-fg">Qualidade</p>
          <Segmented label="Qualidade" options={QUALITY_OPTIONS} value={draft.quality} onChange={(quality) => dispatch({ type: "set", patch: { quality } })} />
        </div>
        <Button variant="secondary" icon={<SlidersHorizontal />} onClick={onPersonalize}>Personalizar</Button>
      </div>
      <p className="mt-4 text-sm text-fg-muted" data-style-estimate>
        {review ? <>Estimativa: <span className="font-medium text-fg tabular">~{formatCredits(review.estimated)} créditos</span>{review.provisional ? " · provisória" : ""}</> : "Créditos indisponíveis."}
      </p>
    </div>
  );
}

export function PersonalizeSheet({ open, onClose, draft, set }: { open: boolean; onClose: () => void; draft: CreateDraft; set: (p: Partial<CreateDraft>) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Personalizar" description="Opcional. Sem mudança aqui, o preset decide."
      footer={<Button onClick={onClose} block>Pronto</Button>}>
      <div className="space-y-5" data-personalize>
        <Field label="Tom"><Input maxLength={120} value={draft.tone} placeholder="Natural e simpático" onChange={(e) => set({ tone: e.target.value })} /></Field>
        <Field label="Chamada final (CTA)"><Input maxLength={200} value={draft.cta} placeholder="Dá uma olhada no link" onChange={(e) => set({ cta: e.target.value })} /></Field>
        <Field label="Ambiente">
          <Select value={draft.environment} onChange={(e) => set({ environment: e.target.value as CreateDraft["environment"] })}>
            <option value="auto">Automático</option>
            {UGC_ENVIRONMENTS.map((id) => <option key={id} value={id}>{UGC_ENVIRONMENT_LABELS[id].label}</option>)}
          </Select>
        </Field>
        {draft.avatar === "auto" ? (
          <Field label="Gênero da apresentadora" hint="Só na escolha automática">
            <Select value={draft.gender} onChange={(e) => set({ gender: e.target.value as CreateDraft["gender"] })}>
              <option value="auto">Automático</option><option value="woman">Mulher</option><option value="man">Homem</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Voz">
          <Select value={draft.voiceLock} onChange={(e) => set({ voiceLock: e.target.value as CreateDraft["voiceLock"] })}>
            <option value="auto">Voz fixa do avatar quando disponível</option>
            <option value="locked">Exigir voz fixa do avatar</option>
            <option value="native">Voz do próprio vídeo</option>
          </Select>
        </Field>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 04 Revisão

function Row({ label, children, onEdit }: { label: string; children: ReactNode; onEdit?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="w-24 shrink-0 text-caption text-fg-subtle sm:w-28">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-fg">{children}</dd>
      {onEdit ? <button type="button" onClick={onEdit} aria-label={`Editar ${label.toLowerCase()}`} className={cx("rounded-md p-1 text-fg-subtle hover:text-fg", interactive, focusRing)}><Pencil className="size-3.5" aria-hidden /></button> : null}
    </div>
  );
}

export function ReviewStep({ draft, avatars, review, dispatch, creditsConfigured }: { draft: CreateDraft; avatars: AvatarChoice[]; review: CreditsReview | null; dispatch: (a: CreateFlowAction) => void; creditsConfigured: boolean }) {
  const goto = (step: CreateStep) => () => dispatch({ type: "goto", step });
  const avatar = avatars.find((a) => a.id === draft.avatar);
  const auto = draft.avatar === "auto" ? autoAvatarPreview(avatars, { name: draft.name, idea: draft.idea }) : null;
  return (
    <div>
      <StepTitle title="Revisão" description="Confira antes de criar o projeto." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <dl className="divide-y divide-line" data-review>
          <Row label="Produto" onEdit={goto("product")}>
            <span className="flex items-center gap-3">
              {draft.images[0]
                // eslint-disable-next-line @next/next/no-img-element -- imagem do upload servida por rota com IDs
                ? <img src={draft.images[0].previewUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-line" />
                : null}
              <span className="min-w-0 truncate font-medium">{draft.name || "—"}</span>
            </span>
          </Row>
          <Row label="Avatar" onEdit={goto("avatar")}>{avatar ? avatar.name : auto?.avatar ? `Escolha automática (provável: ${auto.avatar.name})` : "Escolha automática"}</Row>
          <Row label="Estilo" onEdit={goto("style")}>{stylePreset(draft.preset).label}</Row>
          <Row label="Duração" onEdit={goto("style")}><span className="tabular">{draft.duration}s</span></Row>
          <Row label="Qualidade" onEdit={goto("style")}>{qualityLabel(draft.quality)}</Row>
          <Row label="Ideia" onEdit={goto("product")}><span className="line-clamp-3 text-fg-muted">{draft.idea}</span></Row>
        </dl>
        <CreditsBox review={review} configured={creditsConfigured} onUse={(c) => dispatch({ type: "set", patch: { duration: c.duration, quality: c.quality } })} />
      </div>
    </div>
  );
}

export function CreditsBox({ review, configured, onUse }: { review: CreditsReview | null; configured: boolean; onUse: (c: NonNullable<CreditsReview["cheaper"]>) => void }) {
  if (!configured || !review) {
    return <div className="rounded-2xl border border-line bg-surface-sunken p-4 text-sm text-fg-muted" data-credits-box="unavailable">Créditos indisponíveis.</div>;
  }
  return (
    <div className={cx("rounded-2xl border p-4", review.insufficient ? "border-warning/40 bg-warning-soft" : "border-line bg-surface-sunken")} data-credits-box={review.insufficient ? "insufficient" : "ok"}>
      <p className="text-caption text-fg-subtle">Estimativa</p>
      <p className="mt-0.5 text-title font-semibold text-fg tabular">~{formatCredits(review.estimated)} <span className="text-sm font-medium text-fg-muted">créditos</span></p>
      {review.provisional ? <p className="text-caption text-fg-subtle">Estimativa provisória.</p> : null}
      {review.remaining !== null ? (
        review.insufficient ? (
          <div role="alert" className="mt-3 space-y-1 text-sm">
            <p className="font-medium text-warning">Saldo insuficiente para esta configuração.</p>
            <p className="text-fg-muted">Necessário: <span className="text-fg tabular">~{formatCredits(review.estimated)}</span></p>
            <p className="text-fg-muted">Disponível: <span className="text-fg tabular">{formatCredits(review.remaining)}</span></p>
            {review.cheaper ? (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => onUse(review.cheaper!)}>
                Usar {review.cheaper.duration}s · {qualityLabel(review.cheaper.quality)} (~{formatCredits(review.cheaper.estimated)})
              </Button>
            ) : null}
          </div>
        ) : (
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-fg-muted">Saldo atual</dt><dd className="text-fg tabular">{formatCredits(review.remaining)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-fg-muted">Saldo estimado após</dt><dd className="text-fg tabular">~{formatCredits(review.after ?? 0)}</dd></div>
          </dl>
        )
      ) : null}
    </div>
  );
}

