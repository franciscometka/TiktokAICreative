import type { Metadata } from "next";
import { newAvatarId } from "@/application/avatar-actions";
import { AvatarStudioForm } from "@/components/avatars/avatar-studio-form";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Novo avatar · Creative Factory" };

export default async function NewAvatarPage() {
  const backend = await getBackend("/avatars/new");
  const loaded = await loadOr(() => backend.voices());
  if (!loaded.ok) return <ServiceUnavailable />;
  return <AvatarStudioForm avatarId={newAvatarId()} voices={loaded.value} />;
}
