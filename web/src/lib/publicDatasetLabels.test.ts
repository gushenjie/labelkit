import { describe, expect, it } from "vitest";

import { candidatePreviewUrl } from "./publicDatasetLabels";

describe("candidatePreviewUrl", () => {
  it("prefers the real image thumbnail over the annotation rendering", () => {
    expect(
      candidatePreviewUrl({
        thumbnail: "https://cdn.roboflow.com/image-thumb.jpg",
        annotation_thumbnail: "https://cdn.roboflow.com/annotation-overlay.png",
      }),
    ).toBe("https://cdn.roboflow.com/image-thumb.jpg");
  });

  it("does not use an annotation rendering as the card cover", () => {
    expect(
      candidatePreviewUrl({
        thumbnail: null,
        annotation_thumbnail: "https://cdn.roboflow.com/annotation-overlay.png",
      }),
    ).toBeNull();
  });
});
