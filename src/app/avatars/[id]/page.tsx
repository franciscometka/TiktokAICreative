import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AvatarProfile } from "@/components/avatars/avatar-profile";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avatar · Creative Factory" };

/** L8.7 — perfil do avatar (revisões e uso nos projetos, só leitura). Edição em /avatars/[id]/edit. */
export default async function AvatarProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const backend = await getBackend(`/avatars/${encodeURIComponent(id)}`);
  const loaded = await loadOr(async () => ({ detail: await backend.avatarDetail(id), voices: await backend.voices() }));
  if (!loaded.ok) return <ServiceUnavailable />;
  const { detail, voices } = loaded.value;
  if (!detail) notFound();
  return <AvatarProfile detail={detail} voices={voices} />;
}
