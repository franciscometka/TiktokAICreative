import type { Metadata } from "next";
import { ProjectLibrary } from "@/components/projects/project-library";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projetos · Creative Factory" };

/**
 * L8.6 — biblioteca de Projetos (dark). Carrega todos os cards uma vez; busca, filtros e ordenação
 * acontecem no cliente (instantâneos, sem backend de busca).
 */
export default async function ProjectsPage() {
  const backend = await getBackend("/projects");
  const loaded = await loadOr(() => backend.projects("all"));
  if (!loaded.ok) return <ServiceUnavailable />;
  return <ProjectLibrary cards={loaded.value} />;
}
