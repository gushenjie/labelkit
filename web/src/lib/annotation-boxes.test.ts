import { describe, expect, it } from "vitest";
import { moveBox, resizeBox, type NormalizedBox, type ResizeHandle } from "./annotation-boxes";

const box: NormalizedBox = {
  class_id: 2,
  x_center: 0.5,
  y_center: 0.5,
  width: 0.4,
  height: 0.4,
};

describe("annotation box editing", () => {
  it("clamps moved boxes to image boundaries", () => {
    expect(moveBox(box, -1, 1)).toMatchObject({ x_center: 0.2, y_center: 0.8 });
  });

  it.each<[ResizeHandle, number, number]>([
    ["n", 0.5, -1], ["ne", 1, 0], ["e", 1, 0.5], ["se", 1, 1],
    ["s", 0.5, 1], ["sw", 0, 1], ["w", 0, 0.5], ["nw", 0, 0],
  ])("resizes from the %s handle without crossing boundaries", (handle, x, y) => {
    const resized = resizeBox(box, handle, x, y, 0.01, 0.01);
    expect(resized.x_center - resized.width / 2).toBeGreaterThanOrEqual(0);
    expect(resized.y_center - resized.height / 2).toBeGreaterThanOrEqual(0);
    expect(resized.x_center + resized.width / 2).toBeLessThanOrEqual(1);
    expect(resized.y_center + resized.height / 2).toBeLessThanOrEqual(1);
    expect(resized.width).toBeGreaterThanOrEqual(0.01);
    expect(resized.height).toBeGreaterThanOrEqual(0.01);
  });
});
