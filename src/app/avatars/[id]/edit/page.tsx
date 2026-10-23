import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AvatarStudioForm } from "@/components/avatars/avatar-studio-form";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Editar avatar · Creative Factory" };

export default async function EditAvatarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const backend = await getBackend(`/avatars/${encodeURIComponent(id)}/edit`);
  const loaded = await loadOr(async () => ({ avatar: await backend.avatar(id), voices: await backend.voices() }));
  if (!loaded.ok) return <ServiceUnavailable />;
  const { avatar, voices } = loaded.value;
  if (!avatar) notFound();
  return <AvatarStudioForm avatarId={avatar.id} initial={avatar} voices={voices} />;
}
