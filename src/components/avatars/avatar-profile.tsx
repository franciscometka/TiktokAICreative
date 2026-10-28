"use client";

import { ArrowLeft, Mic, Pencil, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AvatarDetailView, VoiceProfileView } from "@/application/avatar-actions";
import { AGE_LABELS, avatarCreateHref, defaultForLabel } from "@/application/avatar-library";
import { Badge, buttonClass, Card, cx, focusRing, interactive, Spark } from "../ds";
import { AvatarPhoto } from "./avatar-photo";

/**
 * L8.7 — perfil do avatar. Abas: Visão geral, Aparência, Voz, Preferências, Histórico. Só dados
 * que o domínio tem (sem motivo inventado nas revisões, sem prévia de voz, sem IDs técnicos).
 */

export type ProfileTab = "overview" | "appearance" | "voice" | "preferences" | "history";
const TABS: { id: ProfileTab; label: string }[] = [
  { id: "overview", label: "Visão geral" }, { id: "appearance", label: "Aparência" }, { id: "voice", label: "Voz" },
  { id: "preferences", label: "Preferências" }, { id: "history", label: "Histórico" },
];

const DATE = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-caption text-fg-subtle">{label}</dt><dd className="mt-0.5 text-sm text-fg">{children}</dd></div>;
}
function Tags({ items, empty = "—" }: { items: readonly string[]; empty?: string }) {
  return items.length ? <span className="flex flex-wrap gap-1.5">{items.map((t) => <Badge key={t}>{t}</Badge>)}</span> : <span className="text-fg-subtle">{empty}</span>;
}

export function AvatarProfile({ detail, voices, initialTab = "overview" }: { detail: AvatarDetailView; voices: VoiceProfileView[]; initialTab?: ProfileTab }) {
  const { avatar, revisions, usage } = detail;
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const voice = voices.find((v) => v.id === avatar.voiceProfileId);
  const current = revisions.find((r) => r.current);
  const standard = defaultForLabel(avatar.defaultForTags);

  function onKeyDown(event: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = event.key === "ArrowRight" ? i + 1 : event.key === "ArrowLeft" ? i - 1 : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = (next + TABS.length) % TABS.length;
    setTab(TABS[target]!.id);
    refs.current[target]?.focus();
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-12 sm:px-8 sm:pt-10" data-avatar-profile>
      <Link href="/avatars" className={cx("inline-flex items-center gap-1.5 text-caption font-medium text-fg-subtle hover:text-fg", interactive, focusRing)}><ArrowLeft className="size-3.5" aria-hidden />Avatares</Link>

      <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <AvatarPhoto name={avatar.name} src={avatar.imageUrl} size="hero" className="mx-auto aspect-[4/5] w-full max-w-[22rem] ring-1 ring-line shadow-raise" />
        </div>

        <div className="min-w-0">
          <header>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-title">{avatar.name}</h1>
              <Badge tone={avatar.active ? "success" : "neutral"} dot>{avatar.active ? "Ativo" : "Inativo"}</Badge>
            </div>
            <p className="mt-1.5 text-sm text-fg-muted">{[avatar.genderLabel, voice?.name ?? avatar.voiceName].filter(Boolean).join(" · ")}</p>
            {standard ? <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-primary-light" data-default-for><Spark inherit />{standard}</p> : null}
            <div className="mt-5 flex flex-wrap gap-2">
              {avatar.active ? <Link href={avatarCreateHref(avatar.id)} className={buttonClass({ variant: "ai" })} data-use-avatar><Spark inherit />Usar em novo vídeo</Link> : null}
              <Link href={`/avatars/${avatar.id}/edit`} className={buttonClass({ variant: "secondary" })}><Pencil aria-hidden />Editar</Link>
            </div>
            {!avatar.active ? <p className="mt-2 text-caption text-fg-subtle">Inativo: não entra na escolha automática nem pode ser usado em novos vídeos até ser ativado.</p> : null}
          </header>

          <div role="tablist" aria-label="Perfil do avatar" onKeyDown={onKeyDown} className="-mx-4 mt-8 flex gap-1 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
            {TABS.map((t, i) => {
              const selected = t.id === tab;
              return (
                <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`tab-${t.id}`} aria-selected={selected} aria-controls={`panel-${t.id}`} tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(t.id)} className={cx("relative h-10 shrink-0 px-3 text-sm font-medium whitespace-nowrap", interactive, focusRing, selected ? "text-fg" : "text-fg-muted hover:text-fg")}>
                  {t.label}
                  <span aria-hidden className={cx("absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-opacity duration-(--dur-normal)", selected ? "bg-primary-light opacity-100" : "opacity-0")} />
                </button>
              );
            })}
          </div>

          <div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-6 animate-fade-in" data-tab={tab}>
            {tab === "overview" ? (
              <div className="space-y-6">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <Row label="Voz">{voice?.name ?? avatar.voiceName ?? <span className="text-fg-subtle">Não definida</span>}</Row>
                  <Row label="Revisão atual">{current ? <span className="tabular">Revisão {current.revision} · {DATE(current.updatedAt)}</span> : `Revisão ${avatar.revision}`}</Row>
                  {usage ? <Row label="Projetos">{usage.count === 0 ? "Ainda não usado" : usage.count === 1 ? "Usado em 1 projeto" : `Usado em ${usage.count} projetos`}</Row> : null}
                  <div className="col-span-2 sm:col-span-3"><Row label="Tags"><Tags items={avatar.tags} /></Row></div>
                </dl>
                <p className={cx("flex items-start gap-2 rounded-xl px-4 py-3 text-sm ring-1 ring-inset", avatar.imageUrl ? "bg-success-soft text-success ring-success/25" : "bg-warning-soft text-warning ring-warning/25")} data-identity>
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {avatar.imageUrl ? "Referência de identidade ativa: os vídeos usam o rosto desta foto." : "Sem foto de referência: a aparência vem da descrição e pode variar entre vídeos."}
                </p>
                {usage?.recent.length ? (
                  <section aria-labelledby="used-title">
                    <h2 id="used-title" className="text-sm font-medium text-fg">Usado recentemente</h2>
                    <ul className="mt-3 grid grid-cols-3 gap-3">
                      {usage.recent.map((p) => (
                        <li key={p.id} className="min-w-0">
                          <Link href={`/campaigns/${p.id}`} className={cx("group block", focusRing)}>
                            <AvatarPhoto name={p.name} src={p.thumbnailUrl} alt="" rounded="xl" size="thumb" className="aspect-[4/5] w-full ring-1 ring-line transition-transform duration-(--dur-normal) group-hover:-translate-y-0.5" />
                            <span className="mt-1.5 block truncate text-caption text-fg-muted group-hover:text-fg">{p.name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}

            {tab === "appearance" ? (
              <div className="space-y-6">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <Row label="Apresenta como">{avatar.genderLabel}</Row>
                  <Row label="Idade visual">{AGE_LABELS[avatar.visualAgeRange]}</Row>
                  <Row label="Cabelo">{avatar.hair || <span className="text-fg-subtle">—</span>}</Row>
                  <Row label="Roupa base">{avatar.defaultOutfit || <span className="text-fg-subtle">—</span>}</Row>
                  <Row label="Ambiente padrão">{avatar.defaultEnvironment || <span className="text-fg-subtle">—</span>}</Row>
                  <Row label="Cenário base">{avatar.environmentLabel ?? "Automático"}</Row>
                  <div className="col-span-2 sm:col-span-3"><Row label="Aparência">{avatar.appearanceDescriptors || <span className="text-fg-subtle">—</span>}</Row></div>
                </dl>
                {avatar.appearancePrompt ? (
                  <details className="rounded-xl bg-surface-sunken px-4 py-3">
                    <summary className={cx("cursor-pointer text-caption font-medium text-fg-muted hover:text-fg", focusRing)}>Avançado</summary>
                    <p className="mt-3 text-caption text-fg-subtle">Descrição-base (substitui a descrição automática)</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap text-fg-muted">{avatar.appearancePrompt}</p>
                  </details>
                ) : null}
                <p className="text-caption text-fg-subtle">Mudar foto, aparência, roupa ou ambiente cria uma nova revisão. Vídeos antigos continuam com a revisão que usaram.</p>
              </div>
            ) : null}

            {tab === "voice" ? (
              <div className="space-y-5" data-voice>
                <Card padding="none" className="flex items-start gap-4 p-5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-light ring-1 ring-inset ring-primary/25"><Mic className="size-5" aria-hidden /></span>
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{voice?.name ?? avatar.voiceName ?? "Voz não definida"}</p>
                    {voice?.style ? <p className="mt-1 text-sm text-fg-muted">{voice.style}</p> : null}
                    {voice?.locale ? <p className="mt-1 text-caption text-fg-subtle">{voice.locale}</p> : null}
                  </div>
                </Card>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <Row label="Estilo de fala">{avatar.speakingStyle || <span className="text-fg-subtle">—</span>}</Row>
                  <Row label="Personalidade">{avatar.personality || <span className="text-fg-subtle">—</span>}</Row>
                </dl>
                <p className="text-caption text-fg-subtle">A prévia de áudio da voz ainda não está disponível.</p>
              </div>
            ) : null}

            {tab === "preferences" ? (
              <dl className="space-y-5">
                <Row label="Padrão para (escolha automática prioriza este avatar)"><Tags items={avatar.defaultForTags} empty="Nenhuma categoria" /></Row>
                <Row label="Categorias preferidas"><Tags items={avatar.preferredProductCategories} empty="Nenhuma" /></Row>
                <Row label="Tags"><Tags items={avatar.tags} empty="Nenhuma" /></Row>
              </dl>
            ) : null}

            {tab === "history" ? <RevisionHistory revisions={revisions} name={avatar.name} /> : null}
          </div>
        </div>
      </div>
    </main>
  );
}

export function RevisionHistory({ revisions, name }: { revisions: AvatarDetailView["revisions"]; name: string }) {
  const [selected, setSelected] = useState<number>(revisions[0]?.revision ?? 0);
  const chosen = revisions.find((r) => r.revision === selected) ?? revisions[0];
  if (!chosen) return null;
  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)]" data-history>
      <ol aria-label="Revisões" className="space-y-2">
        {revisions.map((r) => {
          const isSel = r.revision === chosen.revision;
          return (
            <li key={r.revision}>
              <button type="button" aria-pressed={isSel} onClick={() => setSelected(r.revision)}
                className={cx("flex w-full items-center gap-3 rounded-xl border p-2.5 text-left", interactive, focusRing, isSel ? "border-primary-light/60 bg-primary-soft" : "border-line bg-surface-sunken hover:border-line-strong")}>
                <AvatarPhoto name={name} src={r.imageUrl} alt="" rounded="xl" size="thumb" className="size-11 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">Revisão {r.revision}{r.current ? <Badge tone="success">Atual</Badge> : null}</span>
                  <span className="text-caption text-fg-subtle tabular">{DATE(r.updatedAt)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="hidden sm:block">
        <AvatarPhoto key={chosen.revision} name={name} src={chosen.imageUrl} alt={`${name} — revisão ${chosen.revision}`} className="aspect-[4/5] w-full ring-1 ring-line" />
        <p className="mt-2 text-caption text-fg-subtle">Revisão {chosen.revision}{chosen.current ? " (atual)" : ""}</p>
      </div>
      <p className="text-caption text-fg-subtle sm:col-span-2">O histórico guarda o número, a data e a foto de cada revisão. Vídeos antigos continuam com a revisão que usaram.</p>
    </div>
  );
}
