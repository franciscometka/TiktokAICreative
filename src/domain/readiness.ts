import type { ExecutionStage } from "./execution";

export interface ReadinessItem {
  id: string;
  label: string;
  selected: string;
  configured: boolean;
  detail: string;
}

export interface RuntimeReadiness {
  readyForControlledRealValidation: boolean;
  issues: { variable: string; message: string }[];
  items: ReadinessItem[];
  dependencies: { stage: ExecutionStage; label: string; detail: string }[];
}

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
