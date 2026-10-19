"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveUgcReferenceAction, regenerateUgcReferenceAction, switchJobToRealAction, updateUgcIdentityAction } from "@/app/actions";
import type { UgcView } from "@/application/ugc-view";
import { buttonClasses, cx, Panel, Spinner } from "@/components/ui/primitives";

/**
 * Aprovação visual do AI UGC: preview grande da pessoa segurando o produto, ANTES de qualquer
 * cena UGC. Aprovar retoma o job dentro do mesmo teto; gerar outra/trocar cria nova versão.
 */
export function UgcReferencePanel({ jobId, ugc, running }: { jobId: string | undefined; ugc: UgcView; running: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>();
  const reference = ugc.current;
  const disabled = pending || running || !jobId;

  const run = (label: string, action: () => Promise<{ ok: boolean; error?: { message: string } }>) =>
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? label : (result.error?.message ?? "Não foi possível concluir."));
      router.refresh();
    });

  return (
    <Panel className="overflow-hidden p-0">
      <div className="grid md:grid-cols-[minmax(16rem,22rem)_1fr]">
        <div className="relative aspect-[9/16] bg-zinc-100">
          {reference?.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- imagem local servida por rota com IDs
            <img className="size-full object-cover" src={reference.previewUrl} alt="Referência: pessoa segurando o produto" />
          ) : (
            <div className="grid size-full place-items-center p-6 text-center text-sm text-zinc-500">
              {ugc.historicalSimulation ? "Referência não gerada: a versão existente é uma simulação (histórico), sem imagem real da pessoa." : reference?.state === "failed" ? "A referência falhou. Gere outra." : reference?.state === "uncertain" ? "Cobrança incerta: o envio pode ter sido aceito. Nenhum reenvio automático." : "Referência ainda não gerada. Ela é criada no início da geração, antes de qualquer cena UGC."}
            </div>
          )}
          {reference?.isMock && reference.previewUrl && (
            <span className="absolute inset-x-3 top-3 rounded-lg bg-black/80 px-3 py-2 text-center text-xs font-semibold text-white">
              MOCK · referência simulada — mostra a foto do produto, não uma pessoa gerada
            </span>
          )}
          {reference && <span className="absolute right-3 bottom-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-zinc-900">{reference.label} · {reference.review === "approved" ? "Aprovada" : reference.review === "rejected" ? "Descartada" : reference.state === "succeeded" ? "Aguardando aprovação" : reference.state}</span>}
        </div>
        <div className="space-y-5 p-6">
          <div>
            <p className="text-xs font-semibold tracking-[0.18em] text-emerald-700 uppercase">AI UGC · referência</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">{ugc.progressLabel && !reference?.previewUrl ? ugc.progressLabel : ugc.headline}</h2>
            {ugc.progressLabel && reference?.previewUrl && <p className="mt-1 text-sm text-zinc-500" aria-live="polite">{ugc.progressLabel}</p>}
            <p className="mt-2 text-sm text-zinc-600">Nenhuma cena UGC é gerada antes da sua aprovação. Todas as cenas usam esta mesma pessoa, roupa, ambiente e produto.</p>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-zinc-500">Quem aparece</dt><dd className="mt-0.5 font-medium">{ugc.person.genderLabel} · {ugc.person.wardrobe}</dd><dd className="text-xs text-zinc-500">{ugc.person.appearance}</dd></div>
            <div><dt className="text-xs text-zinc-500">O que segura</dt><dd className="mt-0.5 font-medium">{ugc.product.name}</dd><dd className="text-xs text-zinc-500">Preserva: {ugc.product.preserve.slice(0, 3).join(", ")}</dd></div>
            <div><dt className="text-xs text-zinc-500">Ambiente</dt><dd className="mt-0.5 font-medium">{ugc.person.environmentLabel}</dd></div>
            <div><dt className="text-xs text-zinc-500">Áudio</dt><dd className="mt-0.5 font-medium">{ugc.audioStrategyLabel}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {ugc.canApprove && reference && (
              <button type="button" className={buttonClasses("primary", "md")} disabled={disabled} onClick={() => run("Referência aprovada. A geração continua dentro do mesmo teto.", () => approveUgcReferenceAction({ jobId, referenceId: reference.id }))}>
                {pending && <Spinner />}Aprovar esta pessoa
              </button>
            )}
            {ugc.canGenerateReal && (
              <button type="button" className={buttonClasses("primary", "md")} disabled={disabled} onClick={() => run("Projeto passou a usar providers REAIS. Gere o vídeo para criar a referência real.", () => switchJobToRealAction({ jobId }))}>
                Gerar referência real
              </button>
            )}
            {ugc.canRegenerate && !ugc.historicalSimulation && (
              <button type="button" className={buttonClasses("secondary", "md")} disabled={disabled} onClick={() => run("Nova referência solicitada (nova versão, novo custo dentro do teto).", () => regenerateUgcReferenceAction({ jobId }))}>
                Gerar outra referência
              </button>
            )}
            <a className={buttonClasses("ghost", "md")} href="#storyboard">Editar conceito</a>
          </div>
          {ugc.canChangeIdentity && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-zinc-600">Trocar apresentador
                <select aria-label="Trocar apresentador" disabled={disabled} className="mt-1 block w-full rounded-md border border-zinc-300 p-2 text-sm" value="" onChange={(e) => e.target.value && run("Apresentador trocado. Uma nova referência será necessária.", () => updateUgcIdentityAction({ jobId, presenter: e.target.value }))}>
                  <option value="">{ugc.person.genderLabel} (atual)</option>
                  <option value="woman">Mulher</option>
                  <option value="man">Homem</option>
                </select>
              </label>
              <label className="text-xs font-medium text-zinc-600">Trocar ambiente
                <select aria-label="Trocar ambiente" disabled={disabled} className="mt-1 block w-full rounded-md border border-zinc-300 p-2 text-sm" value="" onChange={(e) => e.target.value && run("Ambiente trocado. Uma nova referência será necessária.", () => updateUgcIdentityAction({ jobId, environment: e.target.value }))}>
                  <option value="">{ugc.person.environmentLabel} (atual)</option>
                  {ugc.environments.filter((env) => env.id !== ugc.person.environment).map((env) => <option key={env.id} value={env.id}>{env.label}</option>)}
                </select>
              </label>
            </div>
          )}
          {ugc.history.length > 1 && <p className="text-xs text-zinc-500">{ugc.history.length} referências geradas (todas ficam no histórico e no custo).</p>}
          {message && <p className={cx("text-sm", "text-zinc-700")} aria-live="polite">{message}</p>}
        </div>
      </div>
    </Panel>
  );
}
