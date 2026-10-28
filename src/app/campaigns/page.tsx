import { redirect } from "next/navigation";

/** Lote 6: a lista de campanhas virou "Projetos" (/projects). Projetos antigos continuam em /campaigns/[id]. */
export default function CampaignsPage() {
  redirect("/projects");
}
