"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { authorizeJobAction, regenerateStoryboardSceneAction, updateStoryboardSceneAction } from "@/app/actions";
import type { CreativeView, ImageView, SceneView } from "@/application/campaign-view";
import type { VisualSource } from "@/domain/creative";
import { formatBrl } from "@/lib/money";
import { buttonClasses, cx, Notice, Panel, Spinner } from "@/components/ui/primitives";
import { inputClasses } from "@/components/ui/field";

const SIMPLE_SOURCES: { value: VisualSource; label: string }[] = [
  { value: "presenter", label: "Apresentador" },
  { value: "product_hero", label: "Produto em destaque" },
  { value: "product_demo", label: "Produto em uso" },
  { value: "lifestyle", label: "Contexto / lifestyle" },
  { value: "product_image", label: "Imagem do produto" },
  { value: "text_card", label: "Texto" },
];

export function SimpleVideoWorkspace({ campaignId, creative, productImages }: { campaignId: string; creative: CreativeView; productImages: ImageView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>();
  const quote = creative.jobQuote;
  const running = !!creative.activity;

  function generate() {
    if (!creative.jobId || !quote) return;
    setMessage(undefined);
    startTransition(async () => {
      const result = await authorizeJobAction({ jobId: creative.jobId, token: quote.token });
      setMessage(result.ok ? "Geração iniciada. O pipeline seguirá automaticamente dentro do teto aprovado." : result.error.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.18em] text-emerald-700 uppercase">Prévia do vídeo</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">Veja a história inteira antes de gerar</h2>
            <p className="mt-1 text-sm text-zinc-600">Edite fala, visual e tipo de cena. A timeline usa a duração planejada.</p>
          </div>
          <p className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white tabular">{creative.durationSeconds.toFixed(0)} segundos</p>
        </div>

        <div className="mt-5 flex overflow-hidden rounded-full bg-zinc-200" aria-label="Timeline do storyboard">
          {creative.scenes.map((scene, index) => (
            <div key={scene.id} className={cx("min-w-14 border-r border-white/70 px-2 py-2 text-center text-[11px] font-semibold", scene.visualSource === "presenter" ? "bg-emerald-300 text-emerald-950" : index % 2 ? "bg-amber-200 text-amber-950" : "bg-sky-200 text-sky-950")} style={{ flexGrow: scene.endSeconds - scene.startSeconds }}>
              {scene.number} · {(scene.endSeconds - scene.startSeconds).toFixed(0)}s
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {creative.scenes.map((scene, index) => (
            <SceneCard key={scene.id} scene={scene} jobId={creative.jobId} reference={productImages[index % Math.max(1, productImages.length)]} editable={!running && ["planned", "cost_estimated", "awaiting_approval"].includes(creative.jobStatus ?? "")} onChanged={() => router.refresh()} />
          ))}
        </div>
      </section>

      {!creative.latestRender && !creative.result?.simulated && <Panel className="border-zinc-900 bg-zinc-950 p-5 text-white sm:p-6">
        <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-xs font-semibold tracking-[0.18em] text-emerald-300 uppercase">Autorização única</p>
            <h3 className="mt-2 text-xl font-semibold">{quote ? `Gerar o vídeo por até ${formatBrl(quote.maximumAuthorizedBrl)}` : "Preparando custo máximo"}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-300">O teto cobre narração, apresentador, cenas e render deste job. Qualquer falha, cobrança incerta ou aumento pausa o fluxo sem retry pago.</p>
            {quote?.blocked && <p className="mt-3 text-sm font-medium text-amber-300">{quote.blocked}</p>}
          </div>
          <button type="button" className={buttonClasses("primary", "lg")} disabled={pending || running || !quote?.ready} onClick={generate}>
            {pending && <Spinner />}
            {running ? "Gerando vídeo…" : creative.interrupted ? "Continuar job com o mesmo teto" : quote ? `Gerar vídeo por até ${formatBrl(quote.maximumAuthorizedBrl)}` : "Calculando…"}
          </button>
        </div>
        {message && <p className="mt-4 text-sm text-zinc-200" aria-live="polite">{message}</p>}
      </Panel>}

      <section>
        <p className="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">Progresso</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {(creative.workflow ?? []).filter((step) => step.id !== "script").map((step) => (
            <div key={step.id} className={cx("rounded-xl border p-3", step.state === "ready" ? "border-emerald-200 bg-emerald-50" : step.state === "running" ? "border-sky-300 bg-sky-50" : step.state === "failed" || step.state === "paused" ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-white")}>
              <p className="text-sm font-semibold">{step.state === "ready" ? "✓" : step.state === "running" ? "●" : "○"} {step.label}</p>
              <p className="mt-1 text-xs text-zinc-600">{step.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {creative.latestRender ? (
        <Panel className="overflow-hidden p-0">
          <div className="grid md:grid-cols-[18rem_1fr]">
            <video className="aspect-[9/16] w-full bg-black object-contain" controls src={creative.latestRender.videoUrl} />
            <div className="p-6"><p className="text-xs font-semibold tracking-[0.18em] text-emerald-700 uppercase">Seu vídeo está pronto</p><h3 className="mt-2 text-2xl font-semibold">Versão final</h3><p className="mt-2 text-sm text-zinc-600">Custo real total: {formatBrl(creative.actual?.totalBrl ?? 0)}</p><div className="mt-5 flex flex-wrap gap-2"><a className={buttonClasses("primary", "md")} href={creative.latestRender.videoUrl}>Assistir</a><a className={buttonClasses("secondary", "md")} href={creative.latestRender.downloadUrl}>Baixar</a><a className={buttonClasses("secondary", "md")} href={`/create?from=${encodeURIComponent(campaignId)}`}>Gerar outra versão</a><a className={buttonClasses("ghost", "md")} href={`/create?from=${encodeURIComponent(campaignId)}&edit=script`}>Editar roteiro</a></div></div>
          </div>
        </Panel>
      ) : creative.result?.simulated ? (
        <Notice title="Simulação concluída — nenhum MP4 foi criado"><span>O pipeline MOCK percorreu todas as etapas. Ative providers em Configurações avançadas para uma futura versão real.</span><span className="mt-3 flex flex-wrap gap-2"><a className={buttonClasses("secondary", "sm")} href={`/create?from=${encodeURIComponent(campaignId)}`}>Gerar outra versão</a><a className={buttonClasses("ghost", "sm")} href={`/create?from=${encodeURIComponent(campaignId)}&edit=script`}>Editar roteiro</a></span></Notice>
      ) : null}
    </div>
  );
}

function SceneCard({ scene, jobId, reference, editable, onChanged }: { scene: SceneView; jobId?: string; reference?: ImageView; editable: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [narration, setNarration] = useState(scene.narration);
  const [visualDescription, setVisualDescription] = useState(scene.visualDescription);
  const [visualSource, setVisualSource] = useState<VisualSource>(scene.visualSource);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [confirmRedo, setConfirmRedo] = useState(false);
  const statusLabel = scene.status === "ready" ? (scene.simulated ? "Simulado" : "Gerado") : scene.status === "generating" ? "Gerando" : scene.status === "failed" ? "Falhou" : "Planejado";

  function save() {
    if (!jobId) return;
    startTransition(async () => {
      const result = await updateStoryboardSceneAction({ jobId, sceneId: scene.id, narration, visualDescription, visualSource });
      if (!result.ok) setError(result.error.message);
      else { setEditing(false); setError(undefined); onChanged(); }
    });
  }

  function newIdea() {
    setVisualDescription(`Nova ideia: mostrar ${visualSource === "presenter" ? "o apresentador explicando" : "o produto em uso"} com composição limpa, movimento natural e foco no detalhe principal da cena ${scene.number}.`);
    setEditing(true);
  }

  function redo() {
    if (!jobId || !scene.regenerationQuote) return;
    startTransition(async () => {
      const stage = scene.visualSource === "presenter" ? "avatar" : "scenes";
      const result = await regenerateStoryboardSceneAction({ jobId, stage, token: scene.regenerationQuote!.token, sceneId: scene.id });
      setError(result.ok ? "Nova versão iniciada. A anterior continua preservada." : result.error.message);
      setConfirmRedo(false);
      onChanged();
    });
  }

  return <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
    <div className="relative aspect-video bg-zinc-100">
      {scene.videoUrl ? <video className="size-full object-cover" controls src={scene.videoUrl} /> : reference ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagem local servida pela rota segura de uploads
        <img className="size-full object-cover" src={reference.previewUrl} alt="Referência do produto" />
      ) : <div className="grid size-full place-items-center text-sm text-zinc-500">Prévia visual planejada</div>}
      <span className="absolute top-3 left-3 rounded-full bg-black/75 px-2.5 py-1 text-xs font-semibold text-white">Cena {scene.number} · {scene.startSeconds.toFixed(0)}–{scene.endSeconds.toFixed(0)}s</span>
      <span className="absolute top-3 right-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-zinc-900">{statusLabel}</span>
    </div>
    <div className="space-y-3 p-4">
      {editing ? <>
        <select className={inputClasses()} value={visualSource} onChange={(event) => setVisualSource(event.target.value as VisualSource)}>{SIMPLE_SOURCES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <textarea aria-label={`Fala da cena ${scene.number}`} className={inputClasses()} rows={3} value={narration} onChange={(event) => setNarration(event.target.value)} />
        <textarea aria-label={`Visual da cena ${scene.number}`} className={inputClasses()} rows={3} value={visualDescription} onChange={(event) => setVisualDescription(event.target.value)} />
        <div className="flex gap-2"><button className={buttonClasses("primary", "sm")} type="button" disabled={pending} onClick={save}>{pending ? "Salvando…" : "Salvar cena"}</button><button className={buttonClasses("ghost", "sm")} type="button" onClick={() => setEditing(false)}>Cancelar</button></div>
      </> : <>
        <div><p className="text-xs font-semibold text-zinc-500 uppercase">{scene.visualSourceLabel}</p><p className="mt-1 text-sm leading-relaxed text-zinc-700">{scene.visualDescription}</p></div>
        {scene.narration && <div className="rounded-lg bg-zinc-50 p-3"><p className="text-[11px] font-semibold text-zinc-500 uppercase">Fala</p><p className="mt-1 text-sm text-zinc-800">“{scene.narration}”</p></div>}
        <div className="flex flex-wrap items-center gap-2">{editable && <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setEditing(true)}>Editar cena</button>}{editable && <button type="button" className={buttonClasses("ghost", "sm")} onClick={newIdea}>Nova ideia em MOCK</button>}{scene.status === "ready" && scene.regenerationQuote?.ready && (confirmRedo ? <><span className="text-xs text-zinc-600">Nova versão por até {formatBrl(scene.regenerationQuote.estimatedBrl)}?</span><button type="button" className={buttonClasses("primary", "sm")} disabled={pending} onClick={redo}>{pending ? "Iniciando…" : "Confirmar"}</button><button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setConfirmRedo(false)}>Cancelar</button></> : <button type="button" className={buttonClasses("ghost", "sm")} disabled={pending} onClick={() => setConfirmRedo(true)}>Refazer esta cena · até {formatBrl(scene.regenerationQuote.estimatedBrl)}</button>)}</div>
      </>}
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </div>
  </article>;
}
