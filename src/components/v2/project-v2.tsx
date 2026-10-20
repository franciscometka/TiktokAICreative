"use client";

import { useRouter } from "next/navigation";
import {
  approveUgcReferenceAction,
  authorizeJobAction,
  estimateChangeRequestAction,
  executePlanningStageAction,
  regenerateStoryboardSceneAction,
  regenerateUgcReferenceAction,
  retryPlanningAction,
} from "@/app/actions";
import type { ProjectV2View } from "@/application/project-v2-view";
import { ProjectV2Panel } from "./project-v2-panel";

/** Liga a tela V2 às Server Actions existentes (mesmas proteções de custo/aprovação). */
export function ProjectV2({ view, campaignId }: { view: ProjectV2View; campaignId: string }) {
  const router = useRouter();
  return (
    <ProjectV2Panel view={view} campaignId={campaignId} advancedHref={`/campaigns/${encodeURIComponent(campaignId)}?view=advanced`}
      handlers={{
        startPlanning: (token) => executePlanningStageAction({ campaignId, token }),
        authorize: (jobId, token) => authorizeJobAction({ jobId, token }),
        // A UX V2 só habilita o botão com o checklist completo: confirma fidelidade explicitamente.
        approve: (jobId, referenceId) => approveUgcReferenceAction({ jobId, referenceId, fidelityConfirmed: true }),
        regenerate: (jobId) => regenerateUgcReferenceAction({ jobId }),
        retryScene: (jobId, sceneId, token) => regenerateStoryboardSceneAction({ jobId, stage: "ugc_video", token, sceneId }),
        retryPlanning: () => retryPlanningAction(campaignId),
        estimateChange: (text) => estimateChangeRequestAction({ campaignId, text }),
        refresh: () => router.refresh(),
      }} />
  );
}
