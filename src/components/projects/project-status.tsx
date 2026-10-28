import { PauseCircle } from "lucide-react";
import type { ProjectStatus } from "@/application/project-v2-view";
import { Badge, StatusDot } from "../ds";

/**
 * L8.6 — status visual do projeto (Projetos e Home). Pronto = success; Gerando = primary com ponto
 * vivo; Na fila = neutro; Aguardando aprovação/atenção = warning; Falhou = danger; Pausado por
 * segurança = warning com ícone de pausa. Worker offline não vira "Falhou".
 */
export const PROJECT_STATUS_TONE: Record<ProjectStatus, "neutral" | "primary" | "success" | "warning" | "danger"> = {
  awaiting_approval: "warning", queued: "neutral", preparing: "primary", generating: "primary", attention: "warning",
  ready: "success", failed: "danger", blocked: "warning", simulated: "neutral",
};

export function ProjectStatusBadge({ status, label }: { status: ProjectStatus; label: string }) {
  const live = status === "generating" || status === "preparing";
  return (
    <span className="inline-flex rounded-full bg-canvas/85" data-project-status={status}>
      <Badge tone={PROJECT_STATUS_TONE[status]} dot={!live && status !== "ready" && status !== "blocked"}>
        {live ? <StatusDot status="busy" live /> : null}
        {status === "blocked" ? <PauseCircle className="size-3.5" aria-hidden /> : null}
        {label}
      </Badge>
    </span>
  );
}
