"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Panel, Spinner } from "../ui/primitives";

const POLL_MS = 2_500;

/**
 * Tela de processamento. O backend só sabe "planejando": as etapas abaixo são o que o
 * planejamento faz, sem marcar nenhuma como concluída (não há progresso real para mostrar).
 * Consulta o servidor (router.refresh) até o estado mudar.
 */
export function PlanningProgress({
  startedAt,
  model,
  qualityLabel,
  creativeCount,
  simulated,
  runs,
}: {
  startedAt: string | undefined;
  model: string;
  qualityLabel: string;
  creativeCount: number;
  simulated: boolean;
  runs: number;
}) {
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const poll = setInterval(() => router.refresh(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [router]);

  const elapsed = startedAt && now ? Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000)) : null;

  return (
    <Panel className="overflow-hidden">
      <div className="relative h-1 overflow-hidden bg-zinc-100" role="progressbar" aria-label="Planejamento em andamento" aria-busy>
        <div className="progress-indeterminate absolute inset-y-0 w-1/3 bg-zinc-900" />
      </div>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Analisando produto</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">Planejando a campanha</h2>
          </div>
          {elapsed !== null && (
            <p className="text-sm text-zinc-500 tabular" aria-live="off">
              {formatElapsed(elapsed)}
            </p>
          )}
        </div>

        <ul className="mt-6 space-y-3 text-sm">
          <li className="flex items-center gap-3 text-zinc-900">
            <span className="grid size-5 place-items-center rounded-full bg-zinc-900 text-white" aria-hidden>
              <svg viewBox="0 0 16 16" className="size-3" fill="none">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Produto recebido
          </li>
          <li className="flex items-start gap-3 text-zinc-700">
            <span className="grid size-5 shrink-0 place-items-center text-zinc-500" aria-hidden>
              <Spinner />
            </span>
            <div>
              <p className="font-medium text-zinc-900">Em andamento, numa única etapa do {simulated ? "planejador simulado" : "Claude"}:</p>
              <ul className="mt-2 grid gap-1.5 text-zinc-600 sm:grid-cols-2">
                {["Analisando público e problemas", "Criando ângulos", "Gerando hooks", "Criando roteiros", "Planejando cenas"].map((s) => (
                  <li key={s} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full border border-zinc-400" aria-hidden />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        </ul>

        <dl className="mt-6 grid gap-4 border-t border-zinc-100 pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500">Modelo</dt>
            <dd className="mt-0.5 font-medium">{simulated ? `${model} (simulado)` : model}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Preset</dt>
            <dd className="mt-0.5 font-medium">{qualityLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Criativos</dt>
            <dd className="mt-0.5 font-medium tabular">{creativeCount}</dd>
          </div>
        </dl>

        <p className="mt-5 text-xs text-zinc-500">
          {simulated
            ? "Modo simulado: nenhuma chamada ao Claude e nenhum custo real."
            : "O planejamento com Claude possui um pequeno custo e já é contabilizado separadamente."}{" "}
          Pode levar alguns minutos; você pode sair desta página e voltar depois.
          {runs > 1 && ` Esta é a execução ${runs} do planejamento desta campanha.`}
        </p>
      </div>
    </Panel>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, "0")}s`;
}
