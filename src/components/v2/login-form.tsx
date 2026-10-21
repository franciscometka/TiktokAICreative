"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/auth-actions";
import { Card, FieldLabel, v2Button, v2Input } from "./ui";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <Card className="p-6">
      <form action={action} className="grid gap-4">
        <input type="hidden" name="next" value={next} />
        <div><FieldLabel htmlFor="login-email">E-mail</FieldLabel><input id="login-email" name="email" type="email" autoComplete="email" required className={v2Input()} /></div>
        <div><FieldLabel htmlFor="login-password">Senha</FieldLabel><input id="login-password" name="password" type="password" autoComplete="current-password" required className={v2Input()} /></div>
        {state?.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
        <button type="submit" className={v2Button("primary", "lg")} disabled={pending}>{pending ? "Entrando…" : "Entrar"}</button>
      </form>
    </Card>
  );
}
