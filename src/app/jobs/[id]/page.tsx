import { redirect, notFound } from "next/navigation";
import { getRuntime } from "@/server/runtime";
import { runtimeMode } from "@/server/session";
export const dynamic = "force-dynamic";
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) notFound();
  if (runtimeMode() === "cloud") redirect("/projects");
  const job = await getRuntime().deps.service.getJob(id).catch(() => undefined);
  if (!job) notFound();
  redirect(`/campaigns/${job.campaignId}#job-${job.id}`);
}
