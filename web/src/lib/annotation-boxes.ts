export type NormalizedBox = {
  class_id: number;
  x_center: number;
  y_center: number;
  width: number;
  height: number;
};

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function moveBox(box: NormalizedBox, dx: number, dy: number): NormalizedBox {
  return {
    ...box,
    x_center: clamp(box.x_center + dx, box.width / 2, 1 - box.width / 2),
    y_center: clamp(box.y_center + dy, box.height / 2, 1 - box.height / 2),
  };
}

export function resizeBox(
  box: NormalizedBox,
  handle: ResizeHandle,
  pointerX: number,
  pointerY: number,
  minWidth = 0.005,
  minHeight = 0.005,
): NormalizedBox {
  let left = box.x_center - box.width / 2;
  let right = box.x_center + box.width / 2;
  let top = box.y_center - box.height / 2;
  let bottom = box.y_center + box.height / 2;
  if (handle.includes("w")) left = clamp(pointerX, 0, right - minWidth);
  if (handle.includes("e")) right = clamp(pointerX, left + minWidth, 1);
  if (handle.includes("n")) top = clamp(pointerY, 0, bottom - minHeight);
  if (handle.includes("s")) bottom = clamp(pointerY, top + minHeight, 1);
  return {
    ...box,
    x_center: (left + right) / 2,
    y_center: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}
