import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AvatarForm } from "@/components/v2/avatar-form";
import { PageHeader } from "@/components/v2/ui";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avatar · Creative Factory" };

export default async function EditAvatarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const backend = await getBackend(`/avatars/${encodeURIComponent(id)}`);
  const loaded = await loadOr(async () => ({ avatar: await backend.avatar(id), voices: await backend.voices() }));
  if (!loaded.ok) return <ServiceUnavailable />;
  const { avatar, voices } = loaded.value;
  if (!avatar) notFound();
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href="/avatars" className="text-sm text-zinc-500 hover:text-zinc-900">← Avatares</Link>
      <div className="mt-3"><PageHeader title={avatar.name} description={`Revisão ${avatar.revision}. Vídeos antigos continuam vinculados à revisão que usaram.`} /></div>
      <div className="mt-8"><AvatarForm avatarId={avatar.id} initial={avatar} voices={voices} /></div>
    </main>
  );
}
