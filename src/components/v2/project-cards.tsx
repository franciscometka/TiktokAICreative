import Link from "next/link";
import type { ProjectCard } from "@/application/project-v2-view";
import { Chip } from "./ui";

/** Cards visuais de projeto: thumbnail, nome, avatar, duração, status e data. Sem IDs técnicos. */

const STATUS_TONE: Record<ProjectCard["status"], "neutral" | "accent" | "success" | "warning"> = {
  awaiting_approval: "warning", queued: "neutral", preparing: "accent", generating: "accent", attention: "warning", ready: "success", failed: "warning", blocked: "warning", simulated: "neutral",
};

export function ProjectCards({ cards, emptyText = "Nenhum projeto ainda. Crie seu primeiro vídeo." }: { cards: ProjectCard[]; emptyText?: string }) {
  if (cards.length === 0) return <p className="rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500">{emptyText}</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((card) => (
        <li key={card.id}>
          <Link href={`/campaigns/${card.id}`} className="group block overflow-hidden rounded-2xl border border-zinc-200/80 bg-white transition hover:border-zinc-300 hover:shadow-sm">
            <div className="aspect-[4/5] bg-zinc-100">
              {card.thumbnailUrl
                // eslint-disable-next-line @next/next/no-img-element -- imagem local servida por rota com IDs
                ? <img src={card.thumbnailUrl} alt="" className="size-full object-cover transition group-hover:scale-[1.02]" />
                : <div className="grid size-full place-items-center text-sm text-zinc-400">Sem foto</div>}
            </div>
            <div className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-1 font-medium text-zinc-950">{card.name}</p>
                <Chip tone={STATUS_TONE[card.status]}>{card.statusLabel}</Chip>
              </div>
              <p className="text-xs text-zinc-500 tabular">{[card.avatarName, card.durationLabel, card.dateLabel].filter(Boolean).join(" · ")}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
