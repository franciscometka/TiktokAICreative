import type { CampaignState } from "@/application/campaign-view";
import type { JobStatus } from "@/domain/pipeline";
import type { Tone } from "../ui/primitives";

export function jobStatusTone(status: JobStatus): Tone {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "budget_exceeded":
      return "amber";
    case "generating":
    case "rendering":
      return "blue";
    default:
      return "neutral";
  }
}

export function campaignStateTone(state: CampaignState): Tone {
  switch (state) {
    case "planned":
      return "green";
    case "planning":
      return "blue";
    case "interrupted":
      return "amber";
    case "failed":
      return "red";
  }
}
