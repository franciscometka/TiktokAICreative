import type { Metadata } from "next";
import { newProductId } from "@/application/campaign-actions";
import { formInputFromRequest, type CampaignFormInput } from "@/application/campaign-form";
import { imagePreviewUrl, type ImageView } from "@/application/campaign-view";
import { CampaignWizard } from "@/components/create/campaign-wizard";
import { ReadinessPanel } from "@/components/readiness-panel";
import { DEFAULT_SPEAKER_PROFILE_ID, SPEAKER_PROFILES } from "@/config/voices";
import { getPresetSummaries, getPublicConfig, getRuntime, getV2Estimates } from "@/server/runtime";
import { listAvatarViews } from "@/application/avatar-actions";
import { CreateVideo } from "@/components/v2/create-video";
import { PageHeader } from "@/components/v2/ui";
import { LocalOnly, ServiceUnavailable } from "@/components/v2/service-unavailable";
import { getBackend, loadOr } from "@/server/backend";
import { runtimeMode } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Criar vídeo · Creative Factory" };

function toInput(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ from?: string; edit?: string; mode?: string }> }) {
  const { from, edit, mode } = await searchParams;
  if (runtimeMode() === "cloud") {
    // Lote 7: Create V2 pela Render API; o wizard técnico antigo fica no modo local.
    if (from || mode === "advanced") return <LocalOnly title="Criação avançada disponível no modo local" />;
    const backend = await getBackend("/create");
    const data = await loadOr(() => backend.bootstrap(0));
    if (!data.ok) return <ServiceUnavailable />;
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
        <PageHeader title="Criar vídeo" description="Foto + ideia + avatar + duração. A gente cuida do roteiro, da apresentadora e da edição." />
        <div className="mt-8">
          <CreateVideo productId={newProductId()} avatars={data.value.avatars.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, tags: a.tags }))}
            estimates={data.value.estimates} planningAvailable={data.value.config.planningAvailable} />
        </div>
      </main>
    );
  }
  const publicConfig = getPublicConfig();
  const { service } = getRuntime().deps;

  // Lote 6: Create V2 é o padrão. "Planejar de novo" (from) e a criação avançada (mode=advanced)
  // continuam no wizard completo, com todas as opções técnicas.
  if (!from && mode !== "advanced") {
    const avatars = await listAvatarViews(getRuntime().deps);
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
        <PageHeader title="Criar vídeo" description="Foto + ideia + avatar + duração. A gente cuida do roteiro, da apresentadora e da edição." />
        <div className="mt-8">
          <CreateVideo productId={newProductId()} avatars={avatars.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, tags: a.tags }))}
            estimates={getV2Estimates()} planningAvailable={publicConfig.planningAvailable} />
        </div>
      </main>
    );
  }

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
  );
}
