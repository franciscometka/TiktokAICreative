import { describe, expect, it } from "vitest";
import { JOB_STATUSES, type JobStatus } from "@/domain/pipeline";
import {
  canTransitionCampaign,
  canTransitionJob,
  InvalidTransitionError,
  JOB_TRANSITIONS,
  transitionCampaign,
  transitionJob,
} from "./states";

describe("máquina de estados do job", () => {
  it("define transições para todos os status", () => {
    expect(Object.keys(JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("segue o caminho feliz planned → … → completed", () => {
    const path: JobStatus[] = ["planned", "cost_estimated", "awaiting_approval", "generating", "rendering", "completed"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionJob(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("NUNCA pula a aprovação: só awaiting_approval, budget_exceeded (decisão) e completed (regeneração) levam a generating", () => {
    const into = JOB_STATUSES.filter((s) => canTransitionJob(s, "generating"));
    expect(into.sort()).toEqual(["awaiting_approval", "budget_exceeded", "completed"]);
    expect(canTransitionJob("planned", "generating")).toBe(false);
    expect(canTransitionJob("cost_estimated", "generating")).toBe(false);
  });

  it("falha não retoma geração paga sozinha: exige nova estimativa (re-render local é permitido)", () => {
    expect(JOB_TRANSITIONS.failed).toEqual(["cost_estimated", "cancelled", "rendering"]);
    expect(JOB_TRANSITIONS.failed).not.toContain("generating");
    expect(JOB_TRANSITIONS.completed).toEqual(["generating", "rendering"]);
  });

  it("cancelled é terminal", () => {
    expect(JOB_TRANSITIONS.cancelled).toEqual([]);
  });

  it("transitionJob lança em transição inválida e atualiza updatedAt", () => {
    const job = { status: "planned" as JobStatus, updatedAt: "t0" };
    expect(transitionJob(job, "cost_estimated", "t1")).toEqual({ status: "cost_estimated", updatedAt: "t1" });
    expect(() => transitionJob(job, "generating", "t1")).toThrow(InvalidTransitionError);
  });
});

describe("máquina de estados da campanha", () => {
  it("draft → planning → planned | failed; failed pode replanejar", () => {
    expect(canTransitionCampaign("draft", "planning")).toBe(true);
    expect(canTransitionCampaign("planning", "planned")).toBe(true);
    expect(canTransitionCampaign("planning", "failed")).toBe(true);
    expect(canTransitionCampaign("failed", "planning")).toBe(true);
    expect(canTransitionCampaign("draft", "planned")).toBe(false);
    expect(() => transitionCampaign({ status: "planned" as const, updatedAt: "" }, "planning", "t")).toThrow(
      InvalidTransitionError,
    );
  });
});
