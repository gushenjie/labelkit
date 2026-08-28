from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np


def image(index: int) -> np.ndarray:
    canvas = np.zeros((96, 96, 3), dtype=np.uint8)
    if index % 2 == 0:
        cv2.rectangle(canvas, (16, 16), (78, 78), (30, 190, 240), -1)
    else:
        cv2.circle(canvas, (48, 48), 30, (220, 90, 40), -1)
    cv2.putText(canvas, str(index), (5, 91), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    return canvas


def main() -> None:
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    for index in range(12):
        assert cv2.imwrite(str(output / f"sample-{index:02d}.png"), image(index))

    video_path = output / "acceptance.avi"
    writer = cv2.VideoWriter(
        str(video_path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        6.0,
        (96, 96),
    )
    if not writer.isOpened():
        raise RuntimeError("Unable to create acceptance AVI")
    for index in range(18):
        writer.write(image(index % 12))
    writer.release()
    (output / "invalid.jpg").write_text("not an image", encoding="utf-8")


if __name__ == "__main__":
    main()
