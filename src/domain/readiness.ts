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
  /** Lote 5.5: readiness geral do fluxo por grupo; `blocking` = primeiro grupo que impede gerar. */
  flow: ReadinessGroup[];
  blocking?: string;
}

export interface ReadinessGroup {
  id: "config" | "planner" | "ugc" | "narration" | "renderer";
  label: string;
  ready: boolean;
  checks: PreflightCheck[];
}

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
