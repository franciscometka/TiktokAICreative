import Link from "next/link";
import { AutoRefresh } from "@/components/campaign/auto-refresh";
import { Notice, buttonClasses } from "@/components/ui/primitives";
import { generationSource } from "@/application/generation-view";
import { GenerationProject } from "@/components/generation/generation-project";
import { LegacyIsland } from "@/components/shell/legacy-island";
import { LocalOnly, ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

/**
 * Lote 7 (modo cloud): projeto lido da Render API. Polling = router.refresh a cada 3s enquanto
 * prepara/gera; fechar a aba não interrompe nada (o worker segue e o estado está no banco).
 */
export async function CloudProjectPage({ id, viewMode }: { id: string; viewMode?: string }) {
  const backend = await getBackend(`/campaigns/${encodeURIComponent(id)}`);
  const loaded = await loadOr(() => backend.project(id));
  if (!loaded.ok) return <ServiceUnavailable />;
  const result = loaded.value;
  if (!result.ok) {
    return (
      <LegacyIsland>
        <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
          <Notice tone="neutral" title={result.error.title}>{result.error.message}</Notice>
          <Link href="/projects" className={`${buttonClasses("secondary", "md")} mt-4`}>Ver projetos</Link>
        </main>
      </LegacyIsland>
    );
  }
  const { view, v2 } = result.value;
  if (!v2 || viewMode === "advanced") return <LocalOnly title="Detalhes técnicos disponíveis no modo local" />;
  const busy = v2.phase === "planning" || v2.phase === "generating";
  return (
    <>
      {busy && <AutoRefresh intervalMs={3_000} />}
      <GenerationProject source={generationSource(view, v2)} campaignId={view.id} />
    </>
  );
}
