import type { Metadata } from "next";
import Link from "next/link";
import { listProjectCards, matchesFilter, type ProjectFilter } from "@/application/project-v2-view";
import { ProjectCards } from "@/components/v2/project-cards";
import { PageHeader, v2Button } from "@/components/v2/ui";
import { cx } from "@/components/ui/primitives";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projetos · Creative Factory" };

const FILTERS: { id: ProjectFilter; label: string }[] = [
  { id: "all", label: "Todos" }, { id: "ready", label: "Prontos" }, { id: "in_progress", label: "Em andamento" }, { id: "attention", label: "Precisa de atenção" },
];

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const active: ProjectFilter = FILTERS.some((f) => f.id === filter) ? (filter as ProjectFilter) : "all";
  const cards = (await listProjectCards(getRuntime().deps)).filter((c) => matchesFilter(c, active));
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader title="Projetos" description="Seus vídeos, do mais recente ao mais antigo." action={<Link href="/create" className={v2Button("primary")}>Criar vídeo</Link>} />
      <nav aria-label="Filtros" className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f.id} href={f.id === "all" ? "/projects" : `/projects?filter=${f.id}`} aria-current={f.id === active ? "page" : undefined}
            className={cx("rounded-full px-3.5 py-1.5 text-sm font-medium transition", f.id === active ? "bg-zinc-950 text-white" : "bg-white text-zinc-600 ring-1 ring-zinc-200 hover:text-zinc-900")}>
            {f.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6"><ProjectCards cards={cards} emptyText={active === "all" ? undefined : "Nenhum projeto neste filtro."} /></div>
    </main>
  );
}
