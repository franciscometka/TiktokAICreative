"use client";

import { RUNWAY_AVATAR_PRESETS } from "@/domain/presenter";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { startPlanningAction } from "@/app/actions";
import {
  CREATIVE_COUNT_OPTIONS,
  FORM_LIMITS,
  parseCampaignForm,
  type CampaignFormInput,
  type FieldErrors,
} from "@/application/campaign-form";
import type { ImageView } from "@/application/campaign-view";
import { STYLE_HINTS, STYLE_NAMES } from "@/application/labels";
import type { UserError } from "@/application/user-errors";
import type { PresetSummary } from "@/costs/preset-summary";
import { CREATIVE_STYLES, type CreativeStyle } from "@/domain/creative";
import { Stepper, stepsFor } from "../stepper";
import { Field, inputClasses } from "../ui/field";
import { buttonClasses, cx, Notice, Panel, Spinner } from "../ui/primitives";
import { ImageUploader } from "./image-uploader";
import { ListEditor } from "./list-editor";
import { QualitySelector } from "./quality-selector";

const DRAFT_KEY = "creative-factory:create-draft:v1";

const PRODUCT_FIELDS = ["projectName", "productId", "name", "url", "description", "features", "benefits", "price", "audience", "notes", "imageIds"];

interface Draft {
  form: CampaignFormInput;
  images: ImageView[];
}

function readDraft(): Draft | undefined {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
}

function hasDraft(): boolean {
  try {
    return window.localStorage.getItem(DRAFT_KEY) !== null;
  } catch {
    return false;
  }
}

const subscribeNoop = () => () => {};

function writeDraft(draft: Draft | undefined): void {
  try {
    if (draft) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Armazenamento indisponível (modo privado): o rascunho só não sobrevive ao refresh.
  }
}

export interface WizardProps {
  presets: PresetSummary[];
  initial: CampaignFormInput;
  initialImages: ImageView[];
  /** true quando os valores vieram de uma campanha existente (não restaura rascunho). */
  fromCampaign: boolean;
  planner: "mock" | "anthropic";
  planningAvailable: boolean;
  /** Perfis de voz (só id/nome/descrição; o voiceId do provider nunca vem ao browser). */
  voices: { id: string; name: string; description: string }[];
  audioProvider: "mock" | "elevenlabs";
}

export function CampaignWizard({
  presets,
  initial,
  initialImages,
  fromCampaign,
  planner,
  planningAvailable,
  voices,
  audioProvider,
}: WizardProps) {
  const router = useRouter();
  const [form, setForm] = useState<CampaignFormInput>(initial);
  const [images, setImages] = useState<ImageView[]>(initialImages);
  const [step, setStep] = useState<0 | 1>(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<UserError | null>(null);
  /** Só grava rascunho depois que o usuário mexeu (não sobrescreve um rascunho salvo ao abrir). */
  const [dirty, setDirty] = useState(false);
  const [draftHandled, setDraftHandled] = useState(false);
  const [pending, startTransition] = useTransition();
  // Rascunho salvo neste navegador (lido só no cliente; no servidor é sempre false).
  const savedDraftAvailable = useSyncExternalStore(subscribeNoop, () => !fromCampaign && hasDraft(), () => false);

  useEffect(() => {
    if (dirty) writeDraft({ form, images });
  }, [form, images, dirty]);

  const update = <K extends keyof CampaignFormInput>(key: K, value: CampaignFormInput[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const updateBudget = (key: keyof CampaignFormInput["budget"], value: string | boolean) => {
    setDirty(true);
    setForm((f) => ({ ...f, budget: { ...f.budget, [key]: value } }));
    setErrors((e) => ({ ...e, [`budget.${key}`]: undefined }));
  };

  const setImageList = (next: ImageView[]) => {
    setDirty(true);
    setImages(next);
    setForm((f) => ({ ...f, imageIds: next.map((i) => i.id) }));
    setErrors((e) => ({ ...e, imageIds: undefined }));
  };

  function restoreDraft() {
    const draft = readDraft();
    if (!draft?.form?.productId) return;
    setForm({ ...initial, ...draft.form, budget: { ...initial.budget, ...draft.form.budget } });
    setImages(draft.images ?? []);
    setErrors({});
    setDirty(true);
    setDraftHandled(true);
  }

  const productErrors = (all: FieldErrors) =>
    Object.fromEntries(Object.entries(all).filter(([k]) => PRODUCT_FIELDS.includes(k.split(".")[0] ?? "")));

  function goToStrategy() {
    const result = parseCampaignForm(form);
    const relevant = result.ok ? {} : productErrors(result.error);
    setErrors(relevant);
    if (Object.keys(relevant).length === 0) {
      setStep(1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function submit() {
    setSubmitError(null);
    const local = parseCampaignForm(form);
    if (!local.ok) {
      setErrors(local.error);
      if (Object.keys(productErrors(local.error)).length > 0) setStep(0);
      return;
    }
    startTransition(async () => {
      const result = await startPlanningAction(form);
      if (result.ok) {
        writeDraft(undefined);
        router.push(`/campaigns/${result.value.campaignId}`);
        return;
      }
      setSubmitError(result.error);
      if (result.fieldErrors) {
        setErrors(result.fieldErrors);
        if (Object.keys(productErrors(result.fieldErrors)).length > 0) setStep(0);
      }
    });
  }

  function resetDraft() {
    writeDraft(undefined);
    setDirty(false);
    setDraftHandled(true);
    setForm(initial);
    setImages(initialImages);
    setErrors({});
    setStep(0);
  }

  const selectedPreset = presets.find((p) => p.quality === form.quality);

  return (
    <div className="space-y-8">
      <Stepper steps={stepsFor(step === 0 ? ["current"] : ["done", "current"])} />

      {!planningAvailable && (
        <Notice tone="red" title="Claude não configurado">
          O planejamento real está ativado (LLM_PROVIDER=anthropic), mas a ANTHROPIC_API_KEY não foi definida no servidor. Você
          pode preencher o formulário, mas o planejamento não poderá ser iniciado.
        </Notice>
      )}

      {savedDraftAvailable && !dirty && !draftHandled && (
        <Notice
          title="Rascunho salvo neste navegador"
          action={
            <div className="flex gap-2">
              <button type="button" className={buttonClasses("ghost", "sm")} onClick={resetDraft}>
                Descartar
              </button>
              <button type="button" className={buttonClasses("secondary", "sm")} onClick={restoreDraft}>
                Restaurar
              </button>
            </div>
          }
        >
          Você começou uma campanha e não chegou a planejar.
        </Notice>
      )}

      {step === 0 ? (
        <Panel className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Produto</h2>
              <p className="mt-1 text-sm text-zinc-600">Use apenas informações verdadeiras: o planejamento não inventa dados.</p>
            </div>
            {dirty && !fromCampaign && (
              <button type="button" className={buttonClasses("ghost", "sm")} onClick={resetDraft}>
                Limpar rascunho
              </button>
            )}
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <Field id="name" label="Nome do produto" required error={errors.name}>
              <input
                id="name"
                className={inputClasses(!!errors.name)}
                value={form.name}
                maxLength={FORM_LIMITS.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Garrafa Térmica Inox 750ml"
              />
            </Field>
            <Field id="url" label="Link" error={errors.url}>
              <input
                id="url"
                type="url"
                inputMode="url"
                className={inputClasses(!!errors.url)}
                value={form.url}
                onChange={(e) => update("url", e.target.value)}
                placeholder="https://"
              />
            </Field>
            <div className="md:col-span-2">
              <Field id="description" label="Descrição" required error={errors.description} hint="O que é, como funciona, materiais, medidas.">
                <textarea
                  id="description"
                  rows={4}
                  className={inputClasses(!!errors.description)}
                  value={form.description}
                  maxLength={FORM_LIMITS.description}
                  onChange={(e) => update("description", e.target.value)}
                />
              </Field>
            </div>
            <Field id="features" label="Características" error={errors.features} hint="Uma por item. Enter adiciona.">
              <ListEditor
                id="features"
                items={form.features}
                onChange={(v) => update("features", v)}
                placeholder="Ex.: Aço inox 304"
                max={FORM_LIMITS.listItems}
                invalid={!!errors.features}
              />
            </Field>
            <Field id="benefits" label="Benefícios" error={errors.benefits} hint="O que a pessoa ganha usando.">
              <ListEditor
                id="benefits"
                items={form.benefits}
                onChange={(v) => update("benefits", v)}
                placeholder="Ex.: Água gelada o dia todo"
                max={FORM_LIMITS.listItems}
                invalid={!!errors.benefits}
              />
            </Field>
            <Field id="price" label="Preço de venda" error={errors.price} hint="Exibido no criativo.">
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500">R$</span>
                <input
                  id="price"
                  inputMode="decimal"
                  className={cx(inputClasses(!!errors.price), "pl-9 tabular")}
                  value={form.price}
                  onChange={(e) => update("price", e.target.value)}
                  placeholder="79,90"
                />
              </div>
            </Field>
            <Field id="audience" label="Público" error={errors.audience}>
              <input
                id="audience"
                className={inputClasses(!!errors.audience)}
                value={form.audience}
                maxLength={FORM_LIMITS.audience}
                onChange={(e) => update("audience", e.target.value)}
                placeholder="Ex.: estudantes que levam água para o dia"
              />
            </Field>
            <div className="md:col-span-2"><Field id="projectName" label="Nome do projeto (opcional)" error={errors.projectName}>
              <input id="projectName" className={inputClasses(!!errors.projectName)} maxLength={120} value={form.projectName ?? ""} onChange={e => update("projectName", e.target.value)} placeholder="Ex.: Garrafa · apresentação de lançamento" />
            </Field></div>
            <div className="md:col-span-2">
              <Field id="notes" label="Observações" error={errors.notes} hint="Cores, variações, materiais já existentes, restrições.">
                <textarea
                  id="notes"
                  rows={2}
                  className={inputClasses(!!errors.notes)}
                  value={form.notes}
                  maxLength={FORM_LIMITS.notes}
                  onChange={(e) => update("notes", e.target.value)}
                />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field id="images" label="Imagens do produto" error={undefined}>
                <ImageUploader productId={form.productId} images={images} onChange={setImageList} error={errors.imageIds} />
              </Field>
            </div>
          </div>

          <div className="mt-8 flex justify-end border-t border-zinc-100 pt-5">
            <button type="button" className={buttonClasses("primary", "lg")} onClick={goToStrategy}>
              Continuar para estratégia
            </button>
          </div>
        </Panel>
      ) : (
        <div className="space-y-6">
          <Panel className="space-y-4 p-5 sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight">Conceito e roteiro</h2>
            <Field id="videoConcept" label="Conceito do vídeo" error={errors.videoConcept} hint="Como apresentar o produto, para quem e qual mensagem destacar.">
              <textarea id="videoConcept" rows={3} maxLength={2000} className={inputClasses(!!errors.videoConcept)} value={form.videoConcept ?? ""} onChange={e => update("videoConcept", e.target.value)} placeholder="Ex.: Apresentador explica os detalhes e intercala fotos do produto." />
            </Field>
            <Field id="scriptMode" label="Roteiro">
              <select id="scriptMode" className={inputClasses()} value={form.scriptMode ?? "generate"} onChange={e => update("scriptMode", e.target.value as "manual" | "generate")}>
                <option value="generate">Sugerir roteiro localmente, sem IA externa</option><option value="manual">Usar meu roteiro</option>
              </select>
            </Field>
            {form.scriptMode === "manual" ? <Field id="script" label="Texto da narração" error={errors.script} hint="Até 400 palavras. Você revisa o texto e as cenas antes de aprovar a simulação.">
              <textarea id="script" rows={7} maxLength={3000} className={inputClasses(!!errors.script)} value={form.script ?? ""} onChange={e => update("script", e.target.value)} />
            </Field> : <p className="text-sm text-zinc-600">O sistema monta uma sugestão usando apenas os dados do produto. O texto será mostrado na revisão, sem chamada ao Claude.</p>}
          </Panel>
          <Panel className="p-5 sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight">Estratégia</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Para <span className="font-medium text-zinc-900">{form.name}</span>.{" "}
              <button type="button" className="font-medium text-zinc-900 underline underline-offset-2" onClick={() => setStep(0)}>
                Editar produto
              </button>
            </p>

            <div className="mt-6 space-y-7">
              <fieldset>
                <legend className="text-sm font-medium text-zinc-900">Quantidade de criativos</legend>
                <div className="mt-2 inline-flex rounded-md border border-zinc-300 bg-white p-0.5" role="radiogroup">
                  {CREATIVE_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={form.creativeCount === n}
                      onClick={() => update("creativeCount", n)}
                      className={cx(
                        "h-8 min-w-11 rounded px-3 text-sm font-medium tabular transition-colors",
                        form.creativeCount === n ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                {errors.creativeCount && <p className="mt-1.5 text-xs font-medium text-red-600">{errors.creativeCount}</p>}
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-zinc-900">Formatos</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <StyleOption
                    checked={form.styleMode === "auto"}
                    title="AUTO"
                    hint="O Claude escolhe os ângulos mais adequados ao produto."
                    onToggle={() => update("styleMode", "auto")}
                    radio
                  />
                  {CREATIVE_STYLES.map((style) => (
                    <StyleOption
                      key={style}
                      checked={form.styleMode === "manual" && form.styles.includes(style)}
                      title={STYLE_NAMES[style]}
                      hint={STYLE_HINTS[style]}
                      onToggle={() => toggleStyle(style)}
                    />
                  ))}
                </div>
                {errors.styles && <p className="mt-1.5 text-xs font-medium text-red-600">{errors.styles}</p>}
              </fieldset>
            </div>
          </Panel>

          <Panel className="p-5 sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight">Qualidade e custo</h2>
            <p className="mt-1 text-sm text-zinc-600">
              O vídeo final é mais longo que o trecho gerado por IA: o restante usa as imagens do produto, textos e composição.
            </p>
            <div className="mt-5">
              <QualitySelector presets={presets} value={form.quality} onChange={(q) => update("quality", q)} />
              {errors.quality && <p className="mt-1.5 text-xs font-medium text-red-600">{errors.quality}</p>}
            </div>
          </Panel>

          <Panel className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">Voz da narração</h2>
              <span
                className={
                  audioProvider === "elevenlabs"
                    ? "rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700"
                    : "rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800"
                }
              >
                {audioProvider === "elevenlabs" ? "Narração real · ElevenLabs" : "MODO DE TESTE"}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              {audioProvider === "elevenlabs"
                ? "A narração é gerada em português do Brasil depois da sua aprovação e entra no custo estimado."
                : "Narração simulada (AUDIO_PROVIDER=mock): nenhuma voz é gerada e nada é cobrado."}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Voz da narração">
              {voices.map((voice) => {
                const selected = (form.speakerProfileId ?? voices[0]?.id) === voice.id;
                return (
                  <button
                    key={voice.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => update("speakerProfileId", voice.id)}
                    className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
                      selected ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-400"
                    }`}
                  >
                    <span className="block text-sm font-medium text-zinc-900">{voice.name}</span>
                    <span className="block text-xs text-zinc-600">{voice.description}</span>
                  </button>
                );
              })}
            </div>
            <Field id="presenter-avatar" label="Avatar apresentador (opcional)">
              <select id="presenter-avatar" className={inputClasses()} aria-label="Avatar apresentador" value={form.presenterPresetId ?? ""} onChange={e => update("presenterPresetId", e.target.value)}>
                <option value="">Sem apresentador</option>
                {RUNWAY_AVATAR_PRESETS.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
              <p className="mt-2 text-xs text-zinc-500">O avatar e a voz escolhidos serão simulados neste job, sem chamada à Runway ou ElevenLabs. Você poderá acompanhar cada etapa e seu custo de referência.</p>
            </Field>
            {errors.presenterPresetId && <p role="alert">{errors.presenterPresetId}</p>}
            {errors.speakerProfileId && <p className="mt-1.5 text-xs font-medium text-red-600">{errors.speakerProfileId}</p>}
          </Panel>

          <Panel className="p-5 sm:p-6">
            <h2 className="text-lg font-semibold tracking-tight">Orçamento</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Esse limite impede que uma geração ou regeneração ultrapasse seu orçamento sem autorização.
            </p>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Field id="budget-creative" label="Limite por criativo" required error={errors["budget.maxCostPerCreativeBrl"]}>
                <MoneyInput
                  id="budget-creative"
                  value={form.budget.maxCostPerCreativeBrl}
                  invalid={!!errors["budget.maxCostPerCreativeBrl"]}
                  onChange={(v) => updateBudget("maxCostPerCreativeBrl", v)}
                />
              </Field>
              <Field id="budget-campaign" label="Limite por campanha" required error={errors["budget.maxCostPerCampaignBrl"]}>
                <MoneyInput
                  id="budget-campaign"
                  value={form.budget.maxCostPerCampaignBrl}
                  invalid={!!errors["budget.maxCostPerCampaignBrl"]}
                  onChange={(v) => updateBudget("maxCostPerCampaignBrl", v)}
                />
              </Field>
            </div>
            <label className="mt-4 flex items-start gap-2.5 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-zinc-300 accent-zinc-900"
                checked={form.budget.allowOverBudget}
                onChange={(e) => updateBudget("allowOverBudget", e.target.checked)}
              />
              <span>
                Permitir que eu autorize exceder o limite.
                <span className="block text-xs text-zinc-500">Nunca é automático: cada excedente pede sua confirmação.</span>
              </span>
            </label>
          </Panel>

          <Panel className="p-5 sm:p-6">
            <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
              <div className="text-sm text-zinc-600">
                <p className="font-medium text-zinc-900">
                  {form.creativeCount} criativo{form.creativeCount > 1 ? "s" : ""} · {selectedPreset?.label} ·{" "}
                  {form.styleMode === "auto" ? "Formatos AUTO" : `${form.styles.length} formato(s)`}
                </p>
                <p className="mt-1">
                  {planner === "mock"
                    ? "Planejamento simulado (LLM_PROVIDER=mock): nenhuma chamada ao Claude e nenhum custo real."
                    : "O planejamento com Claude possui um pequeno custo e já é contabilizado separadamente."}{" "}
                  Nenhum vídeo é gerado antes da sua aprovação.
                </p>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <button type="button" className={buttonClasses("secondary", "lg")} onClick={() => setStep(0)} disabled={pending}>
                  Voltar
                </button>
                <button
                  type="button"
                  className={buttonClasses("primary", "lg")}
                  onClick={submit}
                  disabled={pending || !planningAvailable}
                >
                  {pending && <Spinner />}
                  {pending ? "Iniciando…" : "Planejar campanha"}
                </button>
              </div>
            </div>
            {submitError && (
              <div className="mt-4">
                <Notice tone="red" title={submitError.title}>
                  {submitError.message}
                </Notice>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );

  function toggleStyle(style: CreativeStyle) {
    setErrors((e) => ({ ...e, styles: undefined }));
    setForm((f) => {
      const current = f.styleMode === "auto" ? [] : f.styles;
      const styles = current.includes(style) ? current.filter((s) => s !== style) : [...current, style];
      return styles.length === 0 ? { ...f, styleMode: "auto", styles: [] } : { ...f, styleMode: "manual", styles };
    });
  }
}

function StyleOption({
  checked,
  title,
  hint,
  onToggle,
  radio,
}: {
  checked: boolean;
  title: string;
  hint: string;
  onToggle: () => void;
  radio?: boolean;
}) {
  return (
    <button
      type="button"
      role={radio ? "radio" : "checkbox"}
      aria-checked={checked}
      onClick={onToggle}
      className={cx(
        "flex items-start gap-2.5 rounded-md border bg-white p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900",
        checked ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300",
      )}
    >
      <span
        className={cx(
          "mt-0.5 grid size-4 shrink-0 place-items-center border",
          radio ? "rounded-full" : "rounded",
          checked ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300",
        )}
        aria-hidden
      >
        {checked && (
          <svg viewBox="0 0 16 16" className="size-3" fill="none">
            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-900">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>
      </span>
    </button>
  );
}

function MoneyInput({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500">R$</span>
      <input
        id={id}
        inputMode="decimal"
        className={cx(inputClasses(invalid), "pl-9 tabular")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
