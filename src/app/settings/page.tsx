import type { Metadata } from "next";
import Link from "next/link";
import { ReadinessPanel } from "@/components/readiness-panel";
import { Card, Chip, PageHeader, v2Button } from "@/components/v2/ui";
import { VoiceProfileForm } from "@/components/v2/voice-profile-form";
import { SPEAKER_PROFILES } from "@/config/voices";
import { VOICE_LOCK_UNAVAILABLE, supportsVoiceLock } from "@/domain/video-speech";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";
import { runtimeMode } from "@/server/session";
import { logoutAction } from "@/app/auth-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Configurações · Creative Factory" };

const STAGE_LABELS: Record<string, string> = {
  planning: "Roteiro (Claude)", narration: "Narração", scenes: "Cenas de produto", avatar: "Presenter", ugc_reference: "Referência AI UGC", ugc_video: "Vídeo AI UGC", render: "Render",
};
const CAPABILITY_LABELS = {
  supportsNativeAudio: "Áudio nativo", supportsExternalAudio: "Áudio externo", supportsLipSync: "Lip-sync", supportsIdentityReference: "Referência de identidade", supportsProductReference: "Referência de produto",
} as const;

/**
 * Configurações (Lote 6). Nada técnico sumiu: providers, modelos, readiness, matriz de capacidades,
 * jobs/IDs e criação avançada vivem em "Avançado / Diagnóstico". Nenhum segredo é exibido.
 */
export default async function SettingsPage() {
  const backend = await getBackend("/settings");
  const loaded = await loadOr(() => backend.settings());
  if (!loaded.ok) return <ServiceUnavailable />;
  const { config, voices, matrix, presets } = loaded.value;
  const cloud = runtimeMode() === "cloud";
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader title="Configurações" action={cloud ? <form action={logoutAction}><button type="submit" className={v2Button("ghost", "sm")}>Sair</button></form> : undefined} />

      <Card className="p-6">
        <h2 className="text-base font-semibold text-zinc-950">Vozes</h2>
        <p className="mt-1 text-sm text-zinc-500">Cada avatar pode ter uma voz fixa. Os IDs de voz do provider ficam só no servidor.</p>
        <ul className="mt-4 divide-y divide-zinc-100">
          {voices.map((v) => <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"><span className="font-medium text-zinc-900">{v.name}</span><span className="text-zinc-500">{v.style} · {v.locale} · velocidade {v.speed.toFixed(2)}{v.builtIn ? " · padrão" : ""}</span></li>)}
        </ul>
        <div className="mt-5 border-t border-zinc-100 pt-5"><VoiceProfileForm bases={SPEAKER_PROFILES.map((s) => ({ id: s.id, name: s.name }))} /></div>
      </Card>

      <details className="theme-light rounded-2xl border border-zinc-200/80 bg-white p-6" data-section="diagnostics">
        <summary className="cursor-pointer text-base font-semibold text-zinc-950">Avançado / Diagnóstico</summary>
        <div className="mt-5 space-y-6">
          <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
            {config.allowMocks ? "Mocks permitidos (ALLOW_MOCKS=true): etapas podem rodar simuladas." : "Fluxo REAL-only: cada chamada paga exige estimativa, teto do job e aprovação."} Planejamento: {config.planner}. Render: {config.renderer}. Cotação USD→BRL {config.exchangeRate.rate} ({config.exchangeRate.source}).
          </p>
          <ReadinessPanel readiness={config.readiness} />
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Providers por etapa</h3>
            <table className="mt-2 w-full text-left text-sm"><tbody className="divide-y divide-zinc-100">
              {Object.entries(config.stageCapabilities).map(([stage, cap]) => <tr key={stage}><td className="py-2 pr-3 text-zinc-700">{STAGE_LABELS[stage] ?? stage}</td><td className="py-2 pr-3 font-mono text-xs text-zinc-500">{cap.provider}</td><td className="py-2">{cap.available ? <Chip tone="success">Disponível</Chip> : <span className="text-xs text-zinc-500">{cap.reason}</span>}</td></tr>)}
            </tbody></table>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Modelos (planejamento)</h3>
            <ul className="mt-2 text-sm text-zinc-600">{presets.map((p) => <li key={p.quality}>{p.label}: {p.llmModelName} · esforço {p.llmEffort} · vídeo {p.videoProviderLabel}</li>)}</ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Voice Lock · capacidades do provider de vídeo</h3>
            {matrix ? <>
              <p className="mt-1 font-mono text-xs text-zinc-500">{matrix.provider} / {matrix.model} · estratégia {matrix.audioStrategy}</p>
              <ul className="mt-2 flex flex-wrap gap-2">{(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map((k) => <li key={k}><Chip tone={matrix.capabilities[k] ? "success" : "neutral"}>{CAPABILITY_LABELS[k]}: {matrix.capabilities[k] ? "sim" : "não"}</Chip></li>)}</ul>
              <p className="mt-2 text-sm text-zinc-600">{supportsVoiceLock(matrix.capabilities) ? "Voice Lock disponível: uma narração contínua com a voz do avatar, sincronizada por trecho." : `${VOICE_LOCK_UNAVAILABLE} Os vídeos usam a fala nativa do provider (registrado em cada projeto).`}</p>
            </> : <p className="mt-1 text-sm text-zinc-500">Provider de vídeo UGC indisponível nesta configuração.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/jobs" className={v2Button("secondary", "sm")}>Jobs e IDs técnicos</Link>
            <Link href="/create?mode=advanced" className={v2Button("secondary", "sm")}>Criação avançada (todas as opções)</Link>
          </div>
        </div>
      </details>
    </main>
  );
}
