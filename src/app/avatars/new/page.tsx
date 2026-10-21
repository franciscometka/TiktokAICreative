import type { Metadata } from "next";
import { newAvatarId } from "@/application/avatar-actions";
import { AvatarForm } from "@/components/v2/avatar-form";
import { PageHeader } from "@/components/v2/ui";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Novo avatar · Creative Factory" };

export default async function NewAvatarPage() {
  const backend = await getBackend("/avatars/new");
  const loaded = await loadOr(() => backend.voices());
  if (!loaded.ok) return <ServiceUnavailable />;
  const voices = loaded.value;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader title="Novo avatar" description="Uma pessoa padrão para apresentar seus produtos, sempre com o mesmo rosto e a mesma voz." />
      <div className="mt-8"><AvatarForm avatarId={newAvatarId()} voices={voices} /></div>
    </main>
  );
}
