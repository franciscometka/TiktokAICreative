import { NextResponse } from "next/server";
import { getBackendFor } from "@/server/backend";
import { accessToken, runtimeMode } from "@/server/session";
import { buildShellStatus, type ShellStatus } from "@/server/shell-status";

export const dynamic = "force-dynamic";

/**
 * L8.1 — dados do shell, consultados pelo cliente por polling leve (30s, só com a aba visível).
 * L8.8.1: leitura leve dedicada (`backend.shell()` + worker em paralelo; nunca cards completos) e
 * namespace de notificações por conta. Local: o próprio Next gera (worker "local"). Cloud: Render
 * API com o token da sessão; sem sessão → nada do usuário. Nada técnico no corpo.
 */

export type { ShellStatus } from "@/server/shell-status";
export type { ShellProject } from "@/application/shell-summary";

export async function GET(): Promise<NextResponse<ShellStatus>> {
  const headers = { "Cache-Control": "no-store" };
  if (runtimeMode() === "local") return NextResponse.json(await buildShellStatus({ mode: "local", backend: getBackendFor(undefined) }), { headers });
  const token = await accessToken();
  return NextResponse.json(await buildShellStatus({ mode: "cloud", token, backend: token ? getBackendFor(token) : null }), { headers });
}
