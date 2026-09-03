import { describe, expect, it } from "vitest";
import { computeCurrentWorkflowStep, computeStepBadges } from "./workflow";

describe("project workflow stage", () => {
  it("starts from material preparation when the project is empty", () => {
    expect(computeCurrentWorkflowStep({ total: 0 })).toBe("materials");
  });

  it("enters training when trainable data exists even if earlier steps have backlog", () => {
    expect(computeCurrentWorkflowStep({ total: 599, unlabeled: 101, human_ok: 20, auto_ok: 579 })).toBe("train");
  });

  it("stays in AI pre-labeling when no trainable data remains", () => {
    expect(computeCurrentWorkflowStep({ total: 20, unlabeled: 3, llm_labeled: 17 })).toBe("label");
  });

  it("moves to label review after pre-labeling produces pending results", () => {
    expect(computeCurrentWorkflowStep({ total: 20, unlabeled: 0, llm_labeled: 20 })).toBe("review");
  });

  it("moves to training or export after review is complete", () => {
    const stats = { total: 20, unlabeled: 0, human_ok: 20 };
    expect(computeCurrentWorkflowStep(stats)).toBe("train");
    expect(computeStepBadges(stats).find((step) => step.slug === "review")?.done).toBe(true);
  });
});
