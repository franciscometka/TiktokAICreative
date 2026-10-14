"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Recarrega os dados do servidor em intervalo enquanto algo está em andamento. */
export function AutoRefresh({ intervalMs = 2_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
