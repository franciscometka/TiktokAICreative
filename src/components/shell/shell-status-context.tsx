"use client";

import { createContext, useContext } from "react";
import type { ShellStatus } from "@/app/api/shell/route";

/**
 * L8.3 — o status que o shell JÁ consulta (worker, usuário, créditos) fica disponível para as
 * páginas. A Home lê o worker daqui: nenhum polling duplicado.
 */
export const ShellStatusContext = createContext<{ status: ShellStatus | null; now: Date }>({ status: null, now: new Date(0) });

export function useShellStatusContext(): { status: ShellStatus | null; now: Date } {
  return useContext(ShellStatusContext);
}
