"use client";

import { useEffect, useState } from "react";
import { WORKER_STATUS_POLL_MS } from "@/application/worker-status";
import type { ShellStatus } from "@/app/api/shell/route";

/**
 * Status do shell (worker + usuário) por polling leve de `/api/shell`: um único timer, só com a
 * aba visível, e reconsulta ao voltar para a aba. Falha de rede mantém o último valor conhecido.
 */
export function useShellStatus(): { status: ShellStatus | null; now: Date } {
  const [state, setState] = useState<{ status: ShellStatus | null; now: Date }>({ status: null, now: new Date(0) });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/shell", { cache: "no-store" });
        if (!response.ok) return;
        const status = (await response.json()) as ShellStatus;
        if (!cancelled) setState({ status, now: new Date() });
      } catch {
        // Sem rede: mantém o último status (o próximo ciclo tenta de novo).
      }
    };
    void load();
    const timer = setInterval(() => void load(), WORKER_STATUS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  return state;
}
