"use client";

import { ArrowLeft, Check, Mic, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { archiveAvatarAction, saveAvatarAction, setAvatarActiveAction } from "@/app/actions";
import type { AvatarView, VoiceProfileView } from "@/application/avatar-actions";
import { AGE_LABELS, avatarFormState, avatarPayload, type AvatarFormState } from "@/application/avatar-library";
import type { ImageView } from "@/application/campaign-view";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import { UGC_ENVIRONMENTS } from "@/domain/ugc";
import { Button, Card, cx, Field, focusRing, Input, interactive, Modal, Segmented, Select, Textarea, useOptionalToast } from "../ds";
import { PhotoDrop } from "../upload/photo-drop";

/**
 * L8.7 — criar/editar avatar em 4 seções (Identidade · Aparência · Voz · Preferências). Por baixo é
 * o MESMO `saveAvatarAction` com o MESMO payload do formulário anterior (`avatarPayload`): a regra
 * de revisão continua no servidor. A foto usa o upload compartilhado (dono = id do avatar; no cloud,
 * URL assinada → Storage, como antes).
 */

const SECTIONS = [
  { id: "identity", number: "01", label: "Identidade" },
  { id: "appearance", number: "02", label: "Aparência" },
  { id: "voice", number: "03", label: "Voz" },
  { id: "preferences", number: "04", label: "Preferências" },
] as const;

export function TagField({ id, label, hint, value, onChange, placeholder }: { id: string; label: string; hint?: string; value: string[]; onChange: (tags: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (draft.trim()) add(draft); }
    if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  }
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
        {hint ? <span className="text-caption text-fg-subtle">{hint}</span> : null}
      </div>
      <div className={cx("flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-surface-sunken px-2.5 py-2", interactive, "focus-within:border-primary-light/70 focus-within:ring-4 focus-within:ring-primary/15")} role="group" aria-label={label}>
        {value.map((tag) => (
          <span key={tag} className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pr-1 pl-2.5 text-[13px] text-fg ring-1 ring-inset ring-primary/30">
            {tag}
            <button type="button" aria-label={`Remover ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))} className={cx("grid size-5 place-items-center rounded-full text-fg-muted hover:bg-fg/10 hover:text-fg", focusRing)}><X className="size-3" aria-hidden /></button>
          </span>
        ))}
        <input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onBlur={() => draft.trim() && add(draft)} placeholder={value.length ? "" : placeholder}
          className="h-7 min-w-28 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle" />
      </div>
      <p className="mt-1.5 text-caption text-fg-subtle">Enter ou vírgula para adicionar.</p>
    </div>
  );
}

function Section({ id, number, label, description, children }: { id: string; number: string; label: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <h2 id={`${id}-title`} className="flex items-baseline gap-2 text-heading font-semibold text-fg"><span className="text-caption text-primary-light tabular">{number}</span>{label}</h2>
      {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

export function AvatarStudioForm({ avatarId, initial, voices }: { avatarId: string; initial?: AvatarView; voices: VoiceProfileView[] }) {
  const router = useRouter();
  const toast = useOptionalToast();
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState<AvatarFormState>(() => avatarFormState(initial));
  const [images, setImages] = useState<ImageView[]>(initial?.imageUrl && initial.referenceImage ? [{ id: initial.referenceImage.imageId, previewUrl: initial.imageUrl }] : []);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [message, setMessage] = useState<string>();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const set = (patch: Partial<AvatarFormState>) => setS((prev) => ({ ...prev, ...patch }));
  const enabledVoices = voices.filter((v) => v.enabled);

  function save() {
    setMessage(undefined);
    startTransition(async () => {
      const result = await saveAvatarAction(avatarPayload(avatarId, { ...s, imageId: images[0]?.id ?? null }));
      if (result.ok) {
        // L8.8: feedback imediato (toast); não vai para a central de notificações.
        toast.show({ id: `avatar:${avatarId}:saved`, title: initial ? "Alterações salvas" : "Avatar criado", description: result.value.revision !== initial?.revision && initial ? `${result.value.name} · nova revisão ${result.value.revision}` : result.value.name, tone: "success" });
        router.push(`/avatars/${avatarId}`); router.refresh();
      } else { setErrors(result.fieldErrors ?? {}); setMessage(result.error.message); }
    });
  }
  function toggleActive() {
    if (!initial) return;
    startTransition(async () => {
      const result = await setAvatarActiveAction({ avatarId, active: !initial.active });
      if (result.ok) toast.show({ id: `avatar:${avatarId}:active`, title: result.value.active ? "Avatar ativado" : "Avatar desativado", description: result.value.active ? undefined : "Não entra na escolha automática.", tone: "success" });
      setMessage(result.ok ? (result.value.active ? "Avatar ativado." : "Avatar desativado: não entra no automático.") : result.error.message);
      router.refresh();
    });
  }
  function archive() {
    startTransition(async () => {
      const result = await archiveAvatarAction(avatarId);
      if (result.ok) { toast.show({ id: `avatar:${avatarId}:archived`, title: "Avatar excluído", description: "Vídeos antigos continuam com a revisão que usaram.", tone: "info" }); router.push("/avatars"); router.refresh(); }
      else { setConfirmArchive(false); setMessage(result.error.message); }
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pt-8 pb-12 sm:px-8 sm:pt-12" data-avatar-form={initial ? "edit" : "new"}>
      <Link href={initial ? `/avatars/${avatarId}` : "/avatars"} className={cx("inline-flex items-center gap-1.5 text-caption font-medium text-fg-subtle hover:text-fg", interactive, focusRing)}><ArrowLeft className="size-3.5" aria-hidden />{initial ? initial.name : "Avatares"}</Link>
      <h1 className="mt-3 text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-title">{initial ? `Editar ${initial.name}` : "Novo avatar"}</h1>
      <p className="mt-2 text-body text-fg-muted">{initial ? `Revisão ${initial.revision}. Vídeos antigos continuam vinculados à revisão que usaram.` : "Uma pessoa padrão para apresentar seus produtos, sempre com o mesmo rosto e a mesma voz."}</p>

      <nav aria-label="Seções" className="-mx-4 mt-6 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        {SECTIONS.map((x) => <a key={x.id} href={`#${x.id}`} className={cx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-fg-muted ring-1 ring-inset ring-line hover:text-fg", interactive, focusRing)}><span className="text-primary-light tabular">{x.number}</span>{x.label}</a>)}
      </nav>

      <Card padding="none" className="mt-6 space-y-10 p-5 sm:p-8">
        <Section {...SECTIONS[0]} description="Quem é este apresentador.">
          <div className="grid gap-6 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            <div>
              <p className="mb-2 text-sm font-medium text-fg">Foto de referência</p>
              <PhotoDrop productId={avatarId} images={images} onChange={(next) => setImages(next.slice(-1))} max={1} error={errors.referenceImage} label="Foto do avatar" />
              <p className="mt-2 text-caption text-fg-subtle">Pessoa adulta, rosto visível; use só fotos com consentimento. Com foto, os vídeos usam este rosto.</p>
            </div>
            <div className="min-w-0 space-y-5">
              <Field label="Nome" error={errors.name}><Input maxLength={60} placeholder="Marina" value={s.name} onChange={(e) => set({ name: e.target.value })} inputSize="lg" /></Field>
              <div><p className="mb-2 text-sm font-medium text-fg">Apresenta como</p><Segmented label="Gênero" options={[{ value: "woman", label: "Mulher" }, { value: "man", label: "Homem" }] as const} value={s.gender} onChange={(gender) => set({ gender })} /></div>
              <Field label="Idade visual">
                <Select value={s.visualAgeRange} onChange={(e) => set({ visualAgeRange: e.target.value as AvatarFormState["visualAgeRange"] })}>
                  {(Object.keys(AGE_LABELS) as AvatarFormState["visualAgeRange"][]).map((k) => <option key={k} value={k}>{AGE_LABELS[k]}</option>)}
                </Select>
              </Field>
              <Field label="Personalidade"><Input maxLength={160} placeholder="Natural e simpática" value={s.personality} onChange={(e) => set({ personality: e.target.value })} /></Field>
            </div>
          </div>
        </Section>

        <Section {...SECTIONS[1]} description="Como ele aparece nos vídeos. Mudar foto, aparência, roupa ou ambiente cria uma nova revisão.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Cabelo"><Input maxLength={160} placeholder="castanho ondulado na altura do ombro" value={s.hair} onChange={(e) => set({ hair: e.target.value })} /></Field>
            <Field label="Roupa base"><Input maxLength={160} placeholder="camiseta branca lisa" value={s.defaultOutfit} onChange={(e) => set({ defaultOutfit: e.target.value })} /></Field>
            <Field label="Ambiente padrão"><Input maxLength={160} placeholder="quarto moderno" value={s.defaultEnvironment} onChange={(e) => set({ defaultEnvironment: e.target.value })} /></Field>
            <Field label="Cenário base">
              <Select value={s.environment} onChange={(e) => set({ environment: e.target.value })}>
                <option value="">Automático</option>{UGC_ENVIRONMENTS.map((id) => <option key={id} value={id}>{UGC_ENVIRONMENT_LABELS[id].label}</option>)}
              </Select>
            </Field>
            <Field label="Aparência" className="sm:col-span-2"><Input maxLength={300} placeholder="sardas leves, sorriso aberto" value={s.appearanceDescriptors} onChange={(e) => set({ appearanceDescriptors: e.target.value })} /></Field>
          </div>
          <details className="rounded-xl bg-surface-sunken px-4 py-3" data-section="advanced">
            <summary className={cx("cursor-pointer text-caption font-medium text-fg-muted hover:text-fg", focusRing)}>Avançado</summary>
            <Field label="Descrição-base (substitui a descrição automática)" className="mt-4">
              <Textarea rows={3} maxLength={600} inputSize="md" value={s.appearancePrompt} onChange={(e) => set({ appearancePrompt: e.target.value })} />
            </Field>
          </details>
        </Section>

        <Section {...SECTIONS[2]} description="A voz fixa usada quando o vídeo permite voz própria do avatar.">
          <div role="radiogroup" aria-label="Voz" className="grid gap-2.5 sm:grid-cols-2">
            {[{ id: "", name: "Sem voz definida", style: "O vídeo usa a voz padrão do projeto." }, ...enabledVoices].map((v) => {
              const selected = s.voiceProfileId === v.id;
              return (
                <button key={v.id || "none"} type="button" role="radio" aria-checked={selected} onClick={() => set({ voiceProfileId: v.id })}
                  className={cx("flex items-start gap-3 rounded-xl border p-3.5 text-left", interactive, focusRing, selected ? "border-primary-light/60 bg-primary-soft ring-1 ring-primary-light/40" : "border-line bg-surface-sunken hover:border-line-strong")}>
                  <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", selected ? "bg-primary text-on-primary ring-primary" : "bg-surface text-fg-subtle ring-line")}>{selected ? <Check className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}</span>
                  <span className="min-w-0"><span className="block text-sm font-medium text-fg">{v.name}</span><span className="mt-0.5 block text-caption text-fg-muted">{v.style}</span></span>
                </button>
              );
            })}
          </div>
          {errors.voiceProfileId ? <p role="alert" className="text-caption font-medium text-danger">{errors.voiceProfileId}</p> : null}
          <Field label="Estilo de fala"><Input maxLength={160} placeholder="frases curtas, tom de conversa" value={s.speakingStyle} onChange={(e) => set({ speakingStyle: e.target.value })} /></Field>
        </Section>

        <Section {...SECTIONS[3]} description="Onde este avatar funciona melhor. As tags são livres — você cria.">
          <TagField id="avatar-tags" label="Tags" value={s.tags} onChange={(tags) => set({ tags })} placeholder="beleza, cabelo…" />
          <TagField id="avatar-default-for" label="Padrão para" hint="a escolha automática prioriza este avatar" value={s.defaultForTags} onChange={(defaultForTags) => set({ defaultForTags })} placeholder="cabelo, ferramentas…" />
          <TagField id="avatar-categories" label="Categorias preferidas" value={s.preferredProductCategories} onChange={(preferredProductCategories) => set({ preferredProductCategories })} />
        </Section>

        <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:flex-wrap sm:items-center">
          <Button size="lg" loading={pending} onClick={save} data-save-avatar>Salvar avatar</Button>
          {initial ? <Button variant="secondary" onClick={toggleActive} disabled={pending}>{initial.active ? "Desativar" : "Ativar"}</Button> : null}
          {initial ? <Button variant="ghost" onClick={() => setConfirmArchive(true)} disabled={pending}>Excluir</Button> : null}
          {message ? <p className="text-sm text-fg-muted" role="status">{message}</p> : null}
        </div>
      </Card>

      <Modal open={confirmArchive} onClose={() => setConfirmArchive(false)} title={`Excluir ${initial?.name ?? "avatar"}?`} size="sm"
        description="Ele some da biblioteca e da escolha automática. Vídeos antigos continuam com a revisão que usaram."
        footer={<><Button variant="secondary" onClick={() => setConfirmArchive(false)}>Cancelar</Button><Button variant="danger" loading={pending} onClick={archive}>Excluir</Button></>} />
    </main>
  );
}
