import type { Metadata } from "next";
import type { ReactNode } from "react";
import { newProductId } from "@/application/campaign-actions";
import { formInputFromRequest, type CampaignFormInput } from "@/application/campaign-form";
import { imagePreviewUrl, type ImageView } from "@/application/campaign-view";
import { initialCreateState } from "@/application/create-flow";
import type { CreditsResult } from "@/application/credits";
import { CampaignWizard } from "@/components/create/campaign-wizard";
import { CreateFlowScreen } from "@/components/create/create-flow-screen";
import { ReadinessPanel } from "@/components/readiness-panel";
import { DEFAULT_SPEAKER_PROFILE_ID, SPEAKER_PROFILES } from "@/config/voices";
import { getPresetSummaries, getPublicConfig, getRuntime } from "@/server/runtime";
import { LocalOnly, ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";
import { runtimeMode } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Criar vídeo · Creative Factory" };

function toInput(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * L8.4 — Create Cinematic em 4 passos (local e cloud, pelos mesmos view models). O rascunho vindo
 * da Home (foto, ideia, preset) e qualquer parâmetro da URL são revalidados em initialCreateState.
 */
async function CinematicCreate({ search }: { search: Search }) {
  const backend = await getBackend("/create");
  const [data, credits] = await Promise.all([
    loadOr(() => backend.bootstrap(0)),
    backend.credits().catch((): CreditsResult => ({ configured: false })),
  ]);
  if (!data.ok) return <ServiceUnavailable />;
  const avatars = data.value.avatars.filter((a) => a.active);
  const initial = initialCreateState({ newProductId: newProductId(), search, avatarIds: avatars.map((a) => a.id) });
  return (
    <CreateFlowScreen
      initial={initial}
      avatars={avatars.map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, tags: a.tags, defaultForTags: a.defaultForTags, preferredProductCategories: a.preferredProductCategories, voiceName: a.voiceName, revision: a.revision, updatedAt: a.updatedAt }))}
      estimates={data.value.estimates}
      credits={credits.configured ? { perBrl: credits.creditsPerBrl, remaining: credits.remaining } : null}
      planningAvailable={data.value.config.planningAvailable}
    />
  );
}

/** Wizard técnico (modo avançado / "Planejar de novo"): continua na ilha clara. */
function LegacyIsland({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-2 sm:px-3 sm:pt-3">
      <div data-surface="legacy" className="theme-light overflow-x-clip rounded-2xl ring-1 ring-white/[0.06]">{children}</div>
    </div>
  );
}

export default async function CreatePage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const from = one(search.from);
  const edit = one(search.edit);
  const mode = one(search.mode);
  if (runtimeMode() === "cloud") {
    // Lote 7: o wizard técnico antigo fica no modo local.
    if (from || mode === "advanced") return <LocalOnly title="Criação avançada disponível no modo local" />;
    return <CinematicCreate search={search} />;
  }

  // Lote 6: Create V2 é o padrão. "Planejar de novo" (from) e a criação avançada (mode=advanced)
  // continuam no wizard completo, com todas as opções técnicas.
  if (!from && mode !== "advanced") return <CinematicCreate search={search} />;

  const publicConfig = getPublicConfig();
  const { service } = getRuntime().deps;

  let initial: CampaignFormInput = {
    simpleFlow: true,
    projectName: "", videoConcept: "", scriptMode: "generate", script: "",
    productId: newProductId(),
    name: "",
    url: "",
    description: "",
    features: [],
    benefits: [],
    price: "",
    audience: "",
    notes: "",
    imageIds: [],
    creativeCount: 1,
    styleMode: "auto",
    styles: [],
    quality: "high",
    presenterPresetId: "influencer",
    presenterChoice: "woman",
    speakerProfileId: DEFAULT_SPEAKER_PROFILE_ID,
    budget: {
      maxCostPerCreativeBrl: toInput(publicConfig.defaultBudget.maxCostPerCreativeBrl),
      maxCostPerCampaignBrl: toInput(publicConfig.defaultBudget.maxCostPerCampaignBrl),
      allowOverBudget: publicConfig.defaultBudget.allowOverBudget,
    },
  };
  let initialImages: ImageView[] = [];
  let fromName: string | undefined;

  // "Planejar de novo com ajustes": parte dos dados de uma campanha existente.
  if (from && /^[A-Za-z0-9_-]{1,128}$/.test(from)) {
    try {
      const campaign = await service.getCampaign(from);
      initial = formInputFromRequest(campaign.request);
      if (edit === "script" && campaign.plan?.creatives[0]) {
        initial.scriptMode = "manual";
        initial.script = campaign.plan.creatives[0].script;
      }
      fromName = campaign.request.product.name;
      initialImages = initial.imageIds.flatMap((id) => {
        const previewUrl = imagePreviewUrl(initial.productId, id);
        return previewUrl ? [{ id, previewUrl }] : [];
      });
    } catch {
      // Campanha inexistente ou ilegível: começa do zero.
    }
  }

  return (
    <LegacyIsland>
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-8">
        <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Nova campanha</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
          {fromName ? `Planejar de novo: ${fromName}` : "Criar projeto e job"}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-zinc-600">
          Informe o produto, escolha o estilo e revise a prévia cena a cena. A geração começa com uma única autorização de custo.
        </p>
      </div>
      <div className="mb-6"><ReadinessPanel readiness={publicConfig.readiness} /></div>
      <CampaignWizard
        stageCapabilities={publicConfig.stageCapabilities}
        presets={getPresetSummaries()}
        initial={initial}
        initialImages={initialImages}
        fromCampaign={fromName !== undefined}
        planner={publicConfig.planner}
        planningAvailable={publicConfig.planningAvailable}
        voices={SPEAKER_PROFILES.map((v) => ({ id: v.id, name: v.name, description: v.description }))}
        audioProvider={publicConfig.audioProvider}
        allowMocks={publicConfig.allowMocks}
      />
    </main>
    </LegacyIsland>
  );
}
