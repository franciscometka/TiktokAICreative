import Link from "next/link";
import { listCampaigns } from "@/application/campaign-actions";
import { CampaignList } from "@/components/campaign-list";
import { QualityPresetCard } from "@/components/quality-preset-card";
import { buttonClasses, Notice } from "@/components/ui/primitives";
import { getPresetSummaries, getPublicConfig, getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const config = getPublicConfig();
  const presets = getPresetSummaries();
  const recent = await listCampaigns(getRuntime().deps, 5);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <section className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Criativos de venda para TikTok Shop</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
          Do produto ao plano de vídeo, com custo estimado antes de qualquer geração. Nada pago de mídia acontece sem sua
          aprovação.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/create" className={buttonClasses("primary", "lg")}>
            Criar campanha
          </Link>
          <Link href="/campaigns" className={buttonClasses("secondary", "lg")}>
            Ver campanhas
          </Link>
        </div>
      </section>

      <div className="mt-8 space-y-2">
        {config.planner === "mock" && (
          <Notice title="Planejamento simulado">LLM_PROVIDER=mock: nenhuma chamada ao Claude e nenhum custo real.</Notice>
        )}
        {!config.planningAvailable && (
          <Notice tone="red" title="Claude não configurado">
            LLM_PROVIDER=anthropic, mas a ANTHROPIC_API_KEY não está definida no servidor.
          </Notice>
        )}
        {config.mediaIsMock && (
          <Notice tone="amber" title="Vídeo e áudio em modo de teste">
            Providers de mídia ainda são simulados: nenhum vídeo real é gerado ou cobrado.
          </Notice>
        )}
      </div>

      <section className="mt-12">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Campanhas recentes</h2>
          {recent.length > 0 && (
            <Link href="/campaigns" className="text-sm font-medium text-zinc-600 hover:text-zinc-900">
              Ver todas
            </Link>
          )}
        </div>
        <CampaignList entries={recent} />
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight">Níveis de qualidade</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Faixas por criativo, calculadas pela tabela de preços atual (cotação USD→BRL {config.exchangeRate.rate}, fonte{" "}
          {config.exchangeRate.source}). Valores são estimativas.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {presets.map((preset) => (
            <QualityPresetCard key={preset.quality} preset={preset} />
          ))}
        </div>
      </section>
    </main>
  );
}
