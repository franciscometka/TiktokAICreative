import { newProductId } from "@/application/campaign-actions";
import type { CreditsResult } from "@/application/credits";
import { HOME_RECENT_LIMIT, homeStats, recentProjects, trustedDisplayName } from "@/application/home-view";
import { HomeScreen } from "@/components/home/home-screen";
import { ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";
import { runtimeMode, sessionClaims } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Home (L8.3 — Cinematic AI Studio). A Home NÃO cria projeto: o composer leva ao /create com foto,
 * ideia e preset pré-preenchidos. Mini dashboard só com dados reais (créditos não configurados →
 * omitidos); o worker vem do status que o shell já consulta.
 */
export default async function HomePage() {
  // Lote 7: local = runtime no processo; cloud = Render API (mesmos view models).
  const backend = await getBackend("/");
  const [data, credits] = await Promise.all([
    loadOr(() => backend.bootstrap(HOME_RECENT_LIMIT)),
    backend.credits().catch((): CreditsResult => ({ configured: false })),
  ]);
  if (!data.ok) return <ServiceUnavailable />;
  const { avatars, recent } = data.value;
  // Nome só da sessão Supabase (user_metadata) e só quando confiável; modo local = sem nome.
  const name = runtimeMode() === "cloud" ? trustedDisplayName(await sessionClaims()) : null;
  const stats = homeStats({
    credits: credits.configured ? { videosGenerated: credits.videosGenerated, remaining: credits.remaining } : null,
    activeAvatars: avatars.filter((a) => a.active).length,
  });
  return <HomeScreen name={name} productId={newProductId()} stats={stats} recent={recentProjects(recent)} />;
}
