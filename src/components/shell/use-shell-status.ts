"use client";

import { useEffect, useState } from "react";
import { WORKER_STATUS_POLL_MS } from "@/application/worker-status";
import type { ShellStatus } from "@/app/api/shell/route";
import { LatestOnly } from "./latest-only";

/**
 * Status do shell (worker + usuário + resumo) por polling leve de `/api/shell`: um único timer, só
 * com a aba visível, e reconsulta ao voltar para a aba. L8.8.1: "só o último vale" — uma leitura
 * nova cancela a anterior e resposta velha nunca sobrescreve uma mais nova. Falha de rede mantém o
 * último valor conhecido.
 */
export function useShellStatus(): { status: ShellStatus | null; now: Date } {
  const [state, setState] = useState<{ status: ShellStatus | null; now: Date }>({ status: null, now: new Date(0) });

  useEffect(() => {
    const poller = new LatestOnly<ShellStatus>(async (signal) => {
      const response = await fetch("/api/shell", { cache: "no-store", signal });
      return response.ok ? ((await response.json()) as ShellStatus) : null;
    }, (status) => setState({ status, now: new Date() }));
    const load = () => { if (document.visibilityState === "visible") void poller.load(); };
    load();
    const timer = setInterval(load, WORKER_STATUS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { poller.stop(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  return state;
}
