import Link from "next/link";
import { newProductId } from "@/application/campaign-actions";
import { CreateVideo } from "@/components/v2/create-video";
import { ProjectCards } from "@/components/v2/project-cards";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";

/** Home V2 (Lote 6): criar direto daqui; nada de provider/modelo/readiness na tela principal. */
export default async function HomePage() {
  // Lote 7: local = runtime no processo; cloud = Render API (mesmos view models).
  const backend = await getBackend("/");
  const data = await loadOr(() => backend.bootstrap(8));
  if (!data.ok) return <ServiceUnavailable />;
  const { avatars, recent, config, estimates } = data.value;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="text-[32px] leading-tight font-semibold tracking-tight text-zinc-950 sm:text-[40px]">Crie seu próximo vídeo</h1>
      <p className="mt-2 text-[15px] text-zinc-500">Foto do produto, uma ideia e a duração. O resto é com a gente.</p>
      <div className="mt-8">
        <CreateVideo compact productId={newProductId()} avatars={avatars.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, tags: a.tags }))}
          estimates={estimates} planningAvailable={config.planningAvailable} />
      </div>
      <section className="mt-14">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-950">Projetos recentes</h2>
          {recent.length > 0 && <Link href="/projects" className="text-sm font-medium text-zinc-500 hover:text-zinc-900">Ver todos</Link>}
        </div>
        <ProjectCards cards={recent} />
      </section>
    </main>
  );
}
