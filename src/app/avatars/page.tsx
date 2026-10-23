import type { Metadata } from "next";
import { AvatarLibrary } from "@/components/avatars/avatar-library";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avatares · Creative Factory" };

/** Biblioteca de avatares (L8.7 — Avatar Studio): apresentadores com identidade e voz próprias. */
export default async function AvatarsPage() {
  const backend = await getBackend("/avatars");
  const loaded = await loadOr(() => backend.avatars());
  if (!loaded.ok) return <ServiceUnavailable />;
  return <AvatarLibrary avatars={loaded.value} />;
}
