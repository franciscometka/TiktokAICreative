import type { Metadata } from "next";
import { listVoiceProfileViews, newAvatarId } from "@/application/avatar-actions";
import { AvatarForm } from "@/components/v2/avatar-form";
import { PageHeader } from "@/components/v2/ui";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Novo avatar · Creative Factory" };

export default async function NewAvatarPage() {
  const voices = await listVoiceProfileViews(getRuntime().deps);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader title="Novo avatar" description="Uma pessoa padrão para apresentar seus produtos, sempre com o mesmo rosto e a mesma voz." />
      <div className="mt-8"><AvatarForm avatarId={newAvatarId()} voices={voices} /></div>
    </main>
  );
}
