"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveVoiceProfileAction } from "@/app/actions";
import { cx } from "../ui/primitives";
import { v2Button, v2Input } from "./ui";

/** Novo perfil de voz: voz base pt-BR + ajustes (velocidade, estabilidade, similaridade). */
export function VoiceProfileForm({ bases }: { bases: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [speakerProfileId, setBase] = useState(bases[0]?.id ?? "");
  const [style, setStyle] = useState("");
  const [speed, setSpeed] = useState(1);
  const [stability, setStability] = useState(0.5);
  const [similarity, setSimilarity] = useState(0.75);
  const [message, setMessage] = useState<string>();
  const save = () => startTransition(async () => {
    const result = await saveVoiceProfileAction({ name, speakerProfileId, style, speed, stability, similarity, enabled: true });
    setMessage(result.ok ? `Voz ${result.value.name} salva.` : result.error.message);
    if (result.ok) { setName(""); setStyle(""); router.refresh(); }
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm text-zinc-700">Nome<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={60} placeholder="Marina BR" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="text-sm text-zinc-700">Voz base
        <select className={cx(v2Input(), "mt-1.5 py-2.5")} value={speakerProfileId} onChange={(e) => setBase(e.target.value)}>{bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label className="text-sm text-zinc-700">Estilo<input className={cx(v2Input(), "mt-1.5 py-2.5")} maxLength={120} placeholder="calorosa, próxima" value={style} onChange={(e) => setStyle(e.target.value)} /></label>
      <label className="text-sm text-zinc-700">Velocidade {speed.toFixed(2)}<input type="range" min={0.7} max={1.2} step={0.05} className="mt-2 block w-full accent-indigo-600" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /></label>
      <label className="text-sm text-zinc-700">Estabilidade {stability.toFixed(2)}<input type="range" min={0} max={1} step={0.05} className="mt-2 block w-full accent-indigo-600" value={stability} onChange={(e) => setStability(Number(e.target.value))} /></label>
      <label className="text-sm text-zinc-700">Similaridade {similarity.toFixed(2)}<input type="range" min={0} max={1} step={0.05} className="mt-2 block w-full accent-indigo-600" value={similarity} onChange={(e) => setSimilarity(Number(e.target.value))} /></label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-3">
        <button type="button" className={v2Button("secondary")} disabled={pending || !name.trim()} onClick={save}>Salvar voz</button>
        {message && <p className="text-sm text-zinc-600" role="status">{message}</p>}
      </div>
    </div>
  );
}
