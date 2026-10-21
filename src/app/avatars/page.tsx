import type { Metadata } from "next";
import Link from "next/link";
import { Card, Chip, PageHeader, v2Button } from "@/components/v2/ui";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avatares · Creative Factory" };

/** Biblioteca de avatares (Lote 6): apresentadores reutilizáveis com identidade e voz próprias. */
export default async function AvatarsPage() {
  const backend = await getBackend("/avatars");
  const loaded = await loadOr(() => backend.avatars());
  if (!loaded.ok) return <ServiceUnavailable />;
  const avatars = loaded.value;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <PageHeader title="Avatares" description="Apresentadores padrão. No modo Automático, escolhemos o avatar pelas tags do produto." action={<Link href="/avatars/new" className={v2Button("primary")}>Novo avatar</Link>} />
      {avatars.length === 0 ? (
        <Card className="mt-8 p-10 text-center">
          <p className="text-[15px] font-medium text-zinc-900">Nenhum avatar ainda</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">Crie apresentadores como “Marina · beleza, cabelo” ou “Lucas · ferramentas”. Sem avatar, cada vídeo usa uma apresentadora gerada automaticamente.</p>
          <Link href="/avatars/new" className={`${v2Button("primary")} mt-5`}>Criar avatar</Link>
        </Card>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {avatars.map((a) => (
            <li key={a.id}>
              <Link href={`/avatars/${a.id}`} className="flex gap-4 rounded-2xl border border-zinc-200/80 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm">
                <div className="size-20 shrink-0 overflow-hidden rounded-xl bg-zinc-100">
                  {/* eslint-disable-next-line @next/next/no-img-element -- imagem local servida por rota com IDs */}
                  {a.imageUrl ? <img src={a.imageUrl} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-2xl font-semibold text-zinc-300">{a.name.charAt(0)}</div>}
                </div>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2"><p className="font-medium text-zinc-950">{a.name}</p>{!a.active && <Chip>Inativo</Chip>}</div>
                  <p className="text-xs text-zinc-500">{[a.genderLabel, a.voiceName ? `Voz: ${a.voiceName}` : null, a.defaultEnvironment || a.environmentLabel].filter(Boolean).join(" · ")}</p>
                  <div className="flex flex-wrap gap-1">{a.tags.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}{a.defaultForTags.length > 0 && <Chip tone="accent">Padrão: {a.defaultForTags.slice(0, 2).join(", ")}</Chip>}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
