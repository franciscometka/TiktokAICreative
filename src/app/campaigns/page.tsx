import type { Metadata } from "next";
import Link from "next/link";
import { listCampaigns } from "@/application/campaign-actions";
import { CampaignList } from "@/components/campaign-list";
import { buttonClasses } from "@/components/ui/primitives";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campanhas · Creative Factory" };

export default async function CampaignsPage() {
  const entries = await listCampaigns(getRuntime().deps);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campanhas</h1>
          <p className="mt-1 text-sm text-zinc-600">Campanhas salvas localmente, mais recentes primeiro.</p>
        </div>
        <Link href="/create" className={buttonClasses("primary", "md")}>
          Criar campanha
        </Link>
      </div>
      <CampaignList entries={entries} />
    </main>
  );
}
