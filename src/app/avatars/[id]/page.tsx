import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAvatarView, listVoiceProfileViews } from "@/application/avatar-actions";
import { AvatarForm } from "@/components/v2/avatar-form";
import { PageHeader } from "@/components/v2/ui";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avatar · Creative Factory" };

export default async function EditAvatarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { deps } = getRuntime();
  const avatar = await getAvatarView(deps, id);
  if (!avatar) notFound();
  const voices = await listVoiceProfileViews(deps);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href="/avatars" className="text-sm text-zinc-500 hover:text-zinc-900">← Avatares</Link>
      <div className="mt-3"><PageHeader title={avatar.name} description={`Revisão ${avatar.revision}. Vídeos antigos continuam vinculados à revisão que usaram.`} /></div>
      <div className="mt-8"><AvatarForm avatarId={avatar.id} initial={avatar} voices={voices} /></div>
    </main>
  );
}
