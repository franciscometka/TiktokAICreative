import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/v2/login-form";
import { PageHeader } from "@/components/v2/ui";
import { runtimeMode, safeNext } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Entrar · Creative Factory" };

/** Lote 7: só existe no modo cloud; o modo local não tem login. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (runtimeMode() !== "cloud") redirect("/");
  return (
    <main className="mx-auto max-w-md px-4 py-16 sm:px-8">
      <PageHeader title="Entrar" description="Use o e-mail e a senha da sua conta." />
      <div className="mt-8"><LoginForm next={safeNext(next)} /></div>
    </main>
  );
}
