import type { Metadata } from "next";
import { newProductId } from "@/application/campaign-actions";
import { formInputFromRequest, type CampaignFormInput } from "@/application/campaign-form";
import { imagePreviewUrl, type ImageView } from "@/application/campaign-view";
import { CampaignWizard } from "@/components/create/campaign-wizard";
import { DEFAULT_SPEAKER_PROFILE_ID, SPEAKER_PROFILES } from "@/config/voices";
import { getPresetSummaries, getPublicConfig, getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Criar campanha · Creative Factory" };

function toInput(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  const publicConfig = getPublicConfig();
  const { service } = getRuntime().deps;

  let initial: CampaignFormInput = {
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
    quality: "economy",
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
          {fromName ? `Planejar de novo: ${fromName}` : "Criar campanha"}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-zinc-600">
          Descreva o produto, escolha a estratégia e o nível de qualidade. Você revisa o plano e o custo antes de qualquer
          geração de vídeo.
        </p>
      </div>
      <CampaignWizard
        presets={getPresetSummaries()}
        initial={initial}
        initialImages={initialImages}
        fromCampaign={fromName !== undefined}
        planner={publicConfig.planner}
        planningAvailable={publicConfig.planningAvailable}
        voices={SPEAKER_PROFILES.map((v) => ({ id: v.id, name: v.name, description: v.description }))}
        audioProvider={publicConfig.audioProvider}
      />
    </main>
  );
}
