"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveAvatarAction, saveAvatarAction, setAvatarActiveAction } from "@/app/actions";
import type { AvatarView, VoiceProfileView } from "@/application/avatar-actions";
import type { ImageView } from "@/application/campaign-view";
import { UGC_ENVIRONMENT_LABELS } from "@/config/ugc";
import { UGC_ENVIRONMENTS } from "@/domain/ugc";
import { ImageUploader } from "../create/image-uploader";
import { cx, Spinner } from "../ui/primitives";
import { TagInput } from "./tag-input";
import { Card, FieldError, FieldLabel, Segmented, v2Button, v2Input } from "./ui";

/** Novo/editar avatar: foto, nome, tags, personalidade, voz e ambiente. Prompt-base fica no avançado. */
export function AvatarForm({ avatarId, initial, voices }: { avatarId: string; initial?: AvatarView; voices: VoiceProfileView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [images, setImages] = useState<ImageView[]>(initial?.imageUrl && initial.referenceImage ? [{ id: initial.referenceImage.imageId, previewUrl: initial.imageUrl }] : []);
  const [name, setName] = useState(initial?.name ?? "");
  const [gender, setGender] = useState<"woman" | "man">(initial?.gender ?? "woman");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [defaultForTags, setDefaultForTags] = useState<string[]>(initial?.defaultForTags ?? []);
  const [personality, setPersonality] = useState(initial?.personality ?? "");
  const [voiceProfileId, setVoiceProfileId] = useState(initial?.voiceProfileId ?? "");
  const [defaultEnvironment, setDefaultEnvironment] = useState(initial?.defaultEnvironment ?? "");
  const [environment, setEnvironment] = useState<string>(initial?.environment ?? "");
  const [hair, setHair] = useState(initial?.hair ?? "");
  const [visualAgeRange, setVisualAgeRange] = useState(initial?.visualAgeRange ?? "30s");
  const [defaultOutfit, setDefaultOutfit] = useState(initial?.defaultOutfit ?? "");
  const [appearanceDescriptors, setAppearanceDescriptors] = useState(initial?.appearanceDescriptors ?? "");
  const [appearancePrompt, setAppearancePrompt] = useState(initial?.appearancePrompt ?? "");
  const [speakingStyle, setSpeakingStyle] = useState(initial?.speakingStyle ?? "");
  const [categories, setCategories] = useState<string[]>(initial?.preferredProductCategories ?? []);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [message, setMessage] = useState<string>();

  function save() {
    setMessage(undefined);
    startTransition(async () => {
      const photo = images[0];
      const result = await saveAvatarAction({
        id: avatarId, name, gender, tags, defaultForTags, personality, defaultEnvironment, hair, visualAgeRange, defaultOutfit,
        appearanceDescriptors, appearancePrompt, speakingStyle, preferredProductCategories: categories,
        ...(environment ? { environment } : {}), ...(voiceProfileId ? { voiceProfileId } : {}),
        ...(photo ? { referenceImage: { ownerId: avatarId, imageId: photo.id } } : {}),
      });
      if (result.ok) { router.push("/avatars"); router.refresh(); }
      else { setErrors(result.fieldErrors ?? {}); setMessage(result.error.message); }
    });
  }

  function toggleActive() {
    if (!initial) return;
    startTransition(async () => {
      const result = await setAvatarActiveAction({ avatarId, active: !initial.active });
      setMessage(result.ok ? (result.value.active ? "Avatar ativado." : "Avatar desativado: não entra no automático.") : result.error.message);
      router.refresh();
    });
  }

  function archive() {
    startTransition(async () => {
      const result = await archiveAvatarAction(avatarId);
      if (result.ok) { router.push("/avatars"); router.refresh(); } else setMessage(result.error.message);
    });
  }

  return (
    <Card className="p-5 sm:p-8">
      <div className="grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div>
          <FieldLabel>Foto/referência</FieldLabel>
          <ImageUploader productId={avatarId} images={images.slice(0, 1)} onChange={(next) => setImages(next.slice(-1))} hint="JPG, PNG ou WebP. Pessoa adulta, rosto visível; use só fotos com consentimento." />
        </div>
        <div className="grid gap-5">
          <div>
            <FieldLabel htmlFor="avatar-name">Nome</FieldLabel>
            <input id="avatar-name" className={v2Input(!!errors.name)} maxLength={60} placeholder="Marina" value={name} onChange={(e) => setName(e.target.value)} />
            <FieldError>{errors.name}</FieldError>
          </div>
          <div><FieldLabel>Apresenta como</FieldLabel><Segmented label="Gênero" options={[{ value: "woman", label: "Mulher" }, { value: "man", label: "Homem" }] as const} value={gender} onChange={setGender} /></div>
          <div><FieldLabel htmlFor="avatar-tags" hint="livres — você cria">Tags</FieldLabel><TagInput id="avatar-tags" label="Tags" value={tags} onChange={setTags} placeholder="beleza, cabelo…" /></div>
          <div>
            <FieldLabel htmlFor="avatar-personality">Personalidade</FieldLabel>
            <input id="avatar-personality" className={v2Input()} maxLength={160} placeholder="Natural e simpática" value={personality} onChange={(e) => setPersonality(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="avatar-voice">Voz</FieldLabel>
            <select id="avatar-voice" className={cx(v2Input(!!errors.voiceProfileId), "py-2.5")} value={voiceProfileId} onChange={(e) => setVoiceProfileId(e.target.value)}>
              <option value="">Escolher voz</option>
              {voices.filter((v) => v.enabled).map((v) => <option key={v.id} value={v.id}>{v.name} — {v.style}</option>)}
            </select>
            <FieldError>{errors.voiceProfileId}</FieldError>
          </div>
          <div>
            <FieldLabel htmlFor="avatar-env">Ambiente padrão</FieldLabel>
            <input id="avatar-env" className={v2Input()} maxLength={160} placeholder="quarto moderno" value={defaultEnvironment} onChange={(e) => setDefaultEnvironment(e.target.value)} />
          </div>
          <div><FieldLabel htmlFor="avatar-default-for" hint="escolha automática">Usar como padrão para</FieldLabel><TagInput id="avatar-default-for" label="Usar como padrão para" value={defaultForTags} onChange={setDefaultForTags} placeholder="cabelo, ferramentas…" /></div>

          <details className="rounded-xl border border-zinc-100 px-4 py-3" data-section="advanced">
            <summary className="cursor-pointer text-sm font-medium text-zinc-500">Configurações avançadas</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-zinc-700">Cabelo<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={160} placeholder="castanho ondulado na altura do ombro" value={hair} onChange={(e) => setHair(e.target.value)} /></label>
              <label className="text-sm text-zinc-700">Idade visual
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={visualAgeRange} onChange={(e) => setVisualAgeRange(e.target.value as typeof visualAgeRange)}>
                  <option value="20s">20–29</option><option value="30s">30–39</option><option value="40s">40–49</option>
                </select></label>
              <label className="text-sm text-zinc-700">Roupa base<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={160} placeholder="camiseta branca lisa" value={defaultOutfit} onChange={(e) => setDefaultOutfit(e.target.value)} /></label>
              <label className="text-sm text-zinc-700">Cenário base
                <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                  <option value="">Automático</option>{UGC_ENVIRONMENTS.map((id) => <option key={id} value={id}>{UGC_ENVIRONMENT_LABELS[id].label}</option>)}
                </select></label>
              <label className="text-sm text-zinc-700">Estilo de fala<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={160} placeholder="frases curtas, tom de conversa" value={speakingStyle} onChange={(e) => setSpeakingStyle(e.target.value)} /></label>
              <div className="text-sm text-zinc-700">Categorias preferidas<div className="mt-1.5"><TagInput id="avatar-categories" label="Categorias preferidas" value={categories} onChange={setCategories} /></div></div>
              <label className="text-sm text-zinc-700 sm:col-span-2">Aparência (descritores)<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={300} value={appearanceDescriptors} onChange={(e) => setAppearanceDescriptors(e.target.value)} /></label>
              <label className="text-sm text-zinc-700 sm:col-span-2">Prompt-base (substitui a descrição automática)
                <textarea rows={3} className={cx(v2Input(), "mt-1.5")} maxLength={600} value={appearancePrompt} onChange={(e) => setAppearancePrompt(e.target.value)} /></label>
              <p className="text-xs text-zinc-500 sm:col-span-2">Mudar foto, aparência, roupa ou ambiente cria uma nova revisão. Vídeos antigos continuam com a revisão que usaram.</p>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-5">
            <button type="button" className={v2Button("primary", "lg")} onClick={save} disabled={pending}>{pending && <Spinner />}Salvar avatar</button>
            {initial && <button type="button" className={v2Button("secondary")} onClick={toggleActive} disabled={pending}>{initial.active ? "Desativar" : "Ativar"}</button>}
            {initial && <button type="button" className={v2Button("ghost")} onClick={archive} disabled={pending}>Excluir</button>}
            {message && <p className="text-sm text-zinc-600" role="status">{message}</p>}
          </div>
        </div>
      </div>
    </Card>
  );
}
