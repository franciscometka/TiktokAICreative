"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext, signIn, signOut } from "@/server/session";

/** Lote 7: login mínimo (Supabase Auth, e-mail + senha). Nenhum segredo sai do servidor. */
const LoginInput = z.object({ email: z.string().trim().email().max(200), password: z.string().min(6).max(200), next: z.string().max(300).optional() });

export async function loginAction(_previous: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const parsed = LoginInput.safeParse({ email: form.get("email"), password: form.get("password"), next: form.get("next") ?? undefined });
  if (!parsed.success) return { error: "Informe e-mail e senha." };
  if (!(await signIn(parsed.data.email, parsed.data.password))) return { error: "E-mail ou senha incorretos." };
  redirect(safeNext(parsed.data.next));
}

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
