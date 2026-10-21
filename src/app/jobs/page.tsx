import Link from "next/link";
import { getRuntime } from "@/server/runtime";
import { runtimeMode } from "@/server/session";
import { LocalOnly } from "@/components/v2/service-unavailable";
import { JOB_STATUS_NAMES } from "@/application/labels";
import { Badge, buttonClasses, Panel } from "@/components/ui/primitives";
export const dynamic = "force-dynamic";
export default async function JobsPage() {
  if (runtimeMode() === "cloud") return <LocalOnly title="Lista técnica de jobs disponível no modo local" />;
  const { service } = getRuntime().deps;
  const ids = await service.listCampaignIds();
  const projects = await Promise.all(ids.map(async id => {
    try { return { campaign: await service.getCampaign(id), jobs: await service.listJobs(id) }; } catch { return undefined; }
  }));
  const rows = projects.flatMap(p => p ? p.jobs.map(job => ({ job, campaign: p.campaign })) : []).sort((a,b) => b.job.updatedAt.localeCompare(a.job.updatedAt));
  return <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6"><div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">Jobs</h1><p className="mt-2 text-sm text-zinc-600">Abra um job para revisar o roteiro, acompanhar as etapas ou continuar as etapas.</p></div><Link href="/create" className={buttonClasses()}>Novo projeto</Link></div>
    <div className="mt-6 space-y-3">{rows.length ? rows.map(({job,campaign}) => <Panel key={job.id} className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{campaign.request.projectName || campaign.request.product.name}</h2><p className="mt-1 break-all text-xs text-zinc-500">{job.id}</p><p className="mt-2 text-sm text-zinc-600">{job.waitingForStage ? "Aguardando etapa" : JOB_STATUS_NAMES[job.status]}{service.isJobInterrupted(job) ? " · aguardando retomada" : ""} · {job.scenes.filter(s => !s.requiresGeneratedVideo || s.attempts.some(a => a.active)).length}/{job.scenes.length} cenas</p></div><div className="flex items-center gap-3"><Badge tone={campaign.executionMode === "offline" ? "blue" : "neutral"}>{campaign.executionMode === "hybrid" ? "Modos por etapa" : campaign.executionMode === "offline" ? "Simulação" : "Consulta"}</Badge><Link href={`/jobs/${job.id}`} className={buttonClasses("secondary", "sm")}>Abrir job</Link></div></div></Panel>) : <Panel className="p-8"><p>Nenhum job ainda. Crie um projeto para começar.</p></Panel>}</div>
  </main>;
}
