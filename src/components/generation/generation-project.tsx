"use client";

import { useRouter } from "next/navigation";
import {
  approveUgcReferenceAction,
  authorizeJobAction,
  estimateChangeRequestAction,
  executePlanningStageAction,
  retryFailedSceneAction,
  regenerateUgcReferenceAction,
  retryPlanningAction,
} from "@/app/actions";
import type { GenerationSource } from "@/application/generation-view";
import { GenerationScreen } from "./generation-screen";

/** Liga a tela de geração às MESMAS Server Actions do Lote 6 (mesmas proteções de custo/aprovação). */
export function GenerationProject({ source, campaignId }: { source: GenerationSource; campaignId: string }) {
  const router = useRouter();
  return (
    <GenerationScreen source={source} campaignId={campaignId} advancedHref={`/campaigns/${encodeURIComponent(campaignId)}?view=advanced`}
      handlers={{
        startPlanning: (token) => executePlanningStageAction({ campaignId, token }),
        authorize: (jobId, token) => authorizeJobAction({ jobId, token }),
        // Só com o checklist completo: confirma fidelidade explicitamente (igual ao Lote 6).
        approve: (jobId, referenceId, confirmedSpecs) => approveUgcReferenceAction({ jobId, referenceId, fidelityConfirmed: true, confirmedSpecs }),
        regenerate: (jobId) => regenerateUgcReferenceAction({ jobId }),
        retryScene: (jobId, sceneId, token) => retryFailedSceneAction({ jobId, token, sceneId }),
        retryPlanning: () => retryPlanningAction(campaignId),
        estimateChange: (text) => estimateChangeRequestAction({ campaignId, text }),
        refresh: () => router.refresh(),
      }} />
  );
}
