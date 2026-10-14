import { QualityPresetCard } from "@/components/quality-preset-card";
import { loadAppConfig } from "@/config/env";
import { PRICING_TABLE } from "@/config/pricing";
import { summarizePresets } from "@/costs/preset-summary";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const config = loadAppConfig();
  const presets = summarizePresets(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-bold">TikTok AI Creative Factory</h1>
      <p className="mt-2 text-neutral-400">
        Lote 1 — planejamento com Claude ({config.llmProvider === "anthropic" ? "API real" : "mock"}). Vídeo, áudio e
        renderização ainda são <strong>mocks</strong>. A página <code>/create</code> chega no Lote 2.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        Cotação USD→BRL: {config.exchangeRate.rate} ({config.exchangeRate.source}). Valores são estimativas.
      </p>
      <section className="mt-8 grid gap-4 md:grid-cols-3">
        {presets.map((preset) => (
          <QualityPresetCard key={preset.quality} preset={preset} />
        ))}
      </section>
    </main>
  );
}
