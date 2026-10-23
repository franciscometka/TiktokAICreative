import { ImageOff } from "lucide-react";
import Link from "next/link";
import type { ProjectCard, ProjectStatus } from "@/application/project-v2-view";
import { Badge, buttonClass, cardClass, cx, EmptyState, focusRing, Spark } from "../ds";

/**
 * L8.3 — projetos recentes da Home (dark). Status REAIS do projeto, sem barra de progresso
 * inventada e sem prévia em MP4 no hover (só a foto do produto). Server-safe.
 */

const STATUS_TONE: Record<ProjectStatus, "neutral" | "primary" | "success" | "warning"> = {
  draft: "neutral", preparing: "primary", generating: "primary", waiting: "warning", ready: "success", attention: "warning", simulated: "neutral",
};

export function RecentProjects({ cards }: { cards: ProjectCard[] }) {
  if (cards.length === 0) {
    return (
      <EmptyState title="Seu estúdio está pronto." description="Crie seu primeiro vídeo com IA."
        action={<Link href="/create" className={buttonClass({ variant: "ai" })}><Spark inherit />Criar vídeo</Link>} />
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" data-recent-count={cards.length}>
      {cards.map((card) => (
        <li key={card.id} className="min-w-0">
          <Link href={`/campaigns/${card.id}`} className={cx(cardClass({ interactive: true }), "group block overflow-hidden", focusRing)}>
            <div className="relative aspect-[4/5] bg-surface-sunken">
              {card.thumbnailUrl
                // eslint-disable-next-line @next/next/no-img-element -- imagem do upload servida por rota com IDs
                ? <img src={card.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
                : <div className="grid size-full place-items-center text-fg-subtle"><ImageOff className="size-5" aria-hidden /><span className="sr-only">Sem foto</span></div>}
              <div className="absolute top-2 left-2 max-w-[calc(100%-1rem)] rounded-full bg-canvas/85"><Badge tone={STATUS_TONE[card.status]} dot={card.status !== "ready"}>{card.statusLabel}</Badge></div>
            </div>
            <div className="space-y-1 p-3 sm:p-4">
              <p className="line-clamp-1 text-sm font-medium text-fg">{card.name}</p>
              <p className="line-clamp-1 text-caption text-fg-subtle tabular">{[card.avatarName, card.durationLabel].filter(Boolean).join(" · ") || card.dateLabel}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
