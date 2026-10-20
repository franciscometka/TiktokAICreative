import Link from "next/link";
import { newProductId } from "@/application/campaign-actions";
import { listAvatarViews } from "@/application/avatar-actions";
import { listProjectCards } from "@/application/project-v2-view";
import { CreateVideo } from "@/components/v2/create-video";
import { ProjectCards } from "@/components/v2/project-cards";
import { getPublicConfig, getRuntime, getV2Estimates } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** Home V2 (Lote 6): criar direto daqui; nada de provider/modelo/readiness na tela principal. */
export default async function HomePage() {
  const { deps } = getRuntime();
  const [avatars, recent] = await Promise.all([listAvatarViews(deps), listProjectCards(deps, 8)]);
  const config = getPublicConfig();
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="text-[32px] leading-tight font-semibold tracking-tight text-zinc-950 sm:text-[40px]">Crie seu próximo vídeo</h1>
      <p className="mt-2 text-[15px] text-zinc-500">Foto do produto, uma ideia e a duração. O resto é com a gente.</p>
      <div className="mt-8">
        <CreateVideo compact productId={newProductId()} avatars={avatars.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, tags: a.tags }))}
          estimates={getV2Estimates()} planningAvailable={config.planningAvailable} />
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
