import type { Metadata } from "next";
import { CreditsScreen, CreditsUnavailable } from "@/components/credits/credits-view";
import { ThemeLight } from "@/components/ds";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Créditos · Creative Factory" };

/** L8.2 — Créditos: derivados do ledger (local: no processo; cloud: Render API). */
export default async function CreditsPage() {
  const backend = await getBackend("/credits");
  const data = await loadOr(() => backend.credits());
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 sm:px-8 sm:pt-12">
      {!data.ok ? <ThemeLight className="rounded-2xl"><ServiceUnavailable /></ThemeLight>
        : data.value.configured ? <CreditsScreen view={data.value} now={new Date()} />
        : <CreditsUnavailable />}
    </main>
  );
}
