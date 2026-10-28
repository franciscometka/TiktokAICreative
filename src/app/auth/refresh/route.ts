import { NextResponse } from "next/server";
import { refreshSession, safeNext } from "@/server/session";

export const runtime = "nodejs";

/** Lote 7: renova a sessão (refresh token em cookie httpOnly) e volta para a página. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const ok = await refreshSession();
  return NextResponse.redirect(new URL(ok ? next : `/login?next=${encodeURIComponent(next)}`, url.origin));
}
