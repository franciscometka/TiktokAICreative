"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { regenerateSceneAction } from "@/app/actions";
import type { PresenterSceneView } from "@/application/presenter-view";
import { buttonClasses } from "../ui/primitives";
export function PresenterPanel({ scenes, jobId }: { scenes: PresenterSceneView[]; jobId?: string }) {
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const router = useRouter();
  if (!scenes.length) return null;
  return <div className="space-y-4">{scenes.map(s => <section key={s.sceneId} className="rounded-md border border-zinc-200 p-4" aria-label={`Presenter ${s.label}`}>
    <h4 className="font-semibold">Apresentador · {s.label} · {s.avatar}{s.simulated ? " · simulado" : ""}</h4>
    <p className="text-sm">{s.status} · estimativa US${s.estimateUsd.toFixed(4)}{s.actualUsd === null ? "" : ` · valor registrado US$${s.actualUsd.toFixed(4)}`}{s.duration === null ? "" : ` · ${s.duration.toFixed(2)}s`}</p>
    <p className="text-xs text-zinc-500">{s.simulated ? "Usa a narração simulada deste job. Nenhuma voz, lip sync ou imagem de avatar foi gerada." : "Voz da narração ElevenLabs · sem nova síntese de voz na Runway."}</p>
    {s.videoUrl ? <video className="mt-3 max-h-80 w-full bg-black" controls preload="metadata" src={s.videoUrl} /> : null}
    {s.error ? <p role="alert" className="mt-2 text-sm text-red-700">{s.error}</p> : null}
    {s.canRegenerate && jobId ? <div className="mt-3">
      {confirm === s.sceneId ? <><p className="text-sm">{s.simulated ? "Simular outra versão, sem cobrança real. Referência estimada: US$" : "Gerar uma nova versão, com nova cobrança estimada de US$"}{s.estimateUsd.toFixed(4)}? A anterior será preservada.</p>
        <button className={buttonClasses()} disabled={pending} onClick={() => startTransition(async () => { const result = await regenerateSceneAction({ jobId, sceneId: s.sceneId }); setMessage(result.ok ? result.value.message : result.error.message); setConfirm(null); router.refresh(); })}>{pending ? "Gerando…" : "Confirmar nova geração"}</button>
        <button className={buttonClasses("secondary")} disabled={pending} onClick={() => setConfirm(null)}>Cancelar</button></> :
        <button className={buttonClasses("secondary")} disabled={pending} onClick={() => setConfirm(s.sceneId)}>Gerar outra versão</button>}
    </div> : null}
  </section>)}{message ? <p role="status">{message}</p> : null}</div>;
}
