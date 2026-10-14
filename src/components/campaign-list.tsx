import Link from "next/link";
import type { CampaignListEntry } from "@/application/campaign-actions";
import { formatBrl } from "@/lib/money";
import { campaignStateTone } from "./campaign/status";
import { Badge, buttonClasses, Panel } from "./ui/primitives";

/** Lista mínima de campanhas: produto, data, preset, estado, custo real. */
export function CampaignList({ entries }: { entries: CampaignListEntry[] }) {
  if (entries.length === 0) {
    return (
      <Panel className="px-5 py-10 text-center">
        <p className="font-medium text-zinc-900">Nenhuma campanha ainda</p>
        <p className="mt-1 text-sm text-zinc-500">Crie a primeira para ver o plano e o custo antes de gerar.</p>
        <Link href="/create" className={`${buttonClasses("primary", "md")} mt-4`}>
          Criar campanha
        </Link>
      </Panel>
    );
  }
  return (
    <Panel className="overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="hidden border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500 md:table-header-group">
          <tr>
            <th className="px-5 py-2.5 font-medium">Produto</th>
            <th className="px-3 py-2.5 font-medium">Data</th>
            <th className="px-3 py-2.5 font-medium">Preset</th>
            <th className="px-3 py-2.5 font-medium">Estado</th>
            <th className="px-3 py-2.5 text-right font-medium">Custo real</th>
            <th className="px-5 py-2.5">
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {entries.map((entry) =>
            entry.ok ? (
              <tr key={entry.item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 md:table-row md:px-0 md:py-0">
                <td className="w-full min-w-0 font-medium text-zinc-900 md:w-auto md:px-5 md:py-3">
                  <Link href={`/campaigns/${entry.item.id}`} className="hover:underline">
                    {entry.item.productName}
                  </Link>
                  <span className="ml-2 text-xs font-normal text-zinc-500">
                    {entry.item.creativeCount} criativo{entry.item.creativeCount > 1 ? "s" : ""}
                  </span>
                </td>
                <td className="text-zinc-600 tabular md:px-3 md:py-3">
                  {new Date(entry.item.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
                </td>
                <td className="text-zinc-600 md:px-3 md:py-3">{entry.item.qualityLabel}</td>
                <td className="md:px-3 md:py-3">
                  <Badge tone={campaignStateTone(entry.item.state)} dot>
                    {entry.item.statusLabel}
                  </Badge>
                </td>
                <td className="text-zinc-900 tabular md:px-3 md:py-3 md:text-right">
                  {formatBrl(entry.item.actualCostBrl)}
                  {entry.item.simulated && <span className="ml-1 text-xs text-zinc-500">simulado</span>}
                </td>
                <td className="ml-auto md:px-5 md:py-3 md:text-right">
                  <Link href={`/campaigns/${entry.item.id}`} className={buttonClasses("secondary", "sm")}>
                    Abrir
                  </Link>
                </td>
              </tr>
            ) : (
              <tr key={entry.id} className="block px-4 py-3 md:table-row md:px-0 md:py-0">
                <td colSpan={6} className="text-sm text-red-700 md:px-5 md:py-3">
                  <span className="font-medium">{entry.error.title}</span>
                  <span className="ml-2 font-mono text-xs text-zinc-500">{entry.id}</span>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </Panel>
  );
}
