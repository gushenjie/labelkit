import { describe, expect, it } from "vitest";
import { computeCurrentWorkflowStep, computeStepBadges, isWorkflowStepUnlocked } from "./workflow";

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

  it("locks later steps until the previous step is finished", () => {
    const emptyStats = { total: 0 };
    const empty = computeStepBadges(emptyStats);
    expect(isWorkflowStepUnlocked("materials", empty, emptyStats)).toBe(true);
    expect(isWorkflowStepUnlocked("label", empty, emptyStats)).toBe(false);
    expect(isWorkflowStepUnlocked("review", empty, emptyStats)).toBe(false);
    expect(isWorkflowStepUnlocked("train", empty, emptyStats)).toBe(false);

    const materialsStats = { total: 20, unlabeled: 20 };
    const afterMaterials = computeStepBadges(materialsStats);
    expect(isWorkflowStepUnlocked("label", afterMaterials, materialsStats)).toBe(true);
    expect(isWorkflowStepUnlocked("review", afterMaterials, materialsStats)).toBe(false);

    const partialStats = { total: 20, unlabeled: 3, llm_labeled: 17 };
    const afterPartialLabel = computeStepBadges(partialStats);
    expect(isWorkflowStepUnlocked("review", afterPartialLabel, partialStats)).toBe(true);

    const labeledStats = { total: 20, unlabeled: 0, llm_labeled: 20 };
    const afterLabel = computeStepBadges(labeledStats);
    expect(isWorkflowStepUnlocked("review", afterLabel, labeledStats)).toBe(true);
    expect(isWorkflowStepUnlocked("train", afterLabel, labeledStats)).toBe(false);

    const reviewedStats = { total: 20, unlabeled: 0, human_ok: 20 };
    const afterReview = computeStepBadges(reviewedStats);
    expect(isWorkflowStepUnlocked("train", afterReview, reviewedStats)).toBe(true);
  });
});
