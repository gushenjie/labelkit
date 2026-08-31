"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";

export type TrialBox = {
  class_id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
};

type Category = { class_id: number; name: string; color: string };

type Props = {
  imageUrl: string | null;
  boxes: TrialBox[];
  categories: Category[];
  loading?: boolean;
  onUpload?: (file: File) => void;
  uploadDisabled?: boolean;
  showSummary?: boolean;
};

function pickImageFile(dataTransfer: DataTransfer): File | null {
  if (dataTransfer.items?.length) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        return item.getAsFile();
      }
    }
  }
  const file = dataTransfer.files[0];
  if (file?.type.startsWith("image/")) return file;
  return null;
}

export function ModelTrialPreview({
  imageUrl,
  boxes,
  categories,
  loading,
  onUpload,
  uploadDisabled = false,
  showSummary = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const lineWidth = Math.max(2, Math.round(canvas.width / 400));
      const fontSize = Math.max(12, Math.round(canvas.width / 50));
      const labelHeight = Math.max(16, Math.round(canvas.width / 45));

      for (const box of boxes) {
        const cat = categories.find((item) => item.class_id === box.class_id);
        const color = cat?.color || "#12A88F";

        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.strokeRect(box.x, box.y, box.w, box.h);

        const label = `${cat?.name ?? `类${box.class_id}`} ${(box.conf * 100).toFixed(0)}%`;
        ctx.font = `${fontSize}px sans-serif`;
        const textWidth = ctx.measureText(label).width;
        const labelY = Math.max(0, box.y - labelHeight);

        ctx.fillStyle = color;
        ctx.fillRect(box.x, labelY, textWidth + 8, labelHeight);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, box.x + 4, labelY + labelHeight - 4);
      }
    };
    img.src = imageUrl;
  }, [imageUrl, boxes, categories]);

  const canUpload = !!onUpload && !uploadDisabled && !loading;

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    event.preventDefault();
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    event.preventDefault();
    setDragging(false);
    const file = pickImageFile(event.dataTransfer);
    if (file) onUpload?.(file);
  };

  const dropZoneProps = canUpload
    ? {
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
      }
    : {};

  if (!imageUrl) {
    return (
      <div
        className={[
          "model-trial-preview",
          "model-trial-preview--empty",
          dragging ? "model-trial-preview--dragging" : "",
          canUpload ? "model-trial-preview--droppable" : "",
        ].filter(Boolean).join(" ")}
        {...dropZoneProps}
      >
        <span aria-hidden>{dragging ? "↓" : "↑"}</span>
        <p>{dragging ? "松开鼠标开始检测" : "拖拽图片到此处，或点击上方「选择图片」"}</p>
      </div>
    );
  }

  return (
    <div
      className={[
        "model-trial-preview",
        dragging ? "model-trial-preview--dragging" : "",
        canUpload ? "model-trial-preview--droppable" : "",
      ].filter(Boolean).join(" ")}
      {...dropZoneProps}
    >
      <canvas ref={canvasRef} className="model-trial-preview__canvas" aria-label="模型检测结果预览" />
      {showSummary && (
        <p className="model-trial-preview__summary" data-testid="model-trial-result">
          {loading ? "正在分析…" : boxes.length > 0 ? `检测到 ${boxes.length} 个目标` : "未检测到目标"}
        </p>
      )}
      {canUpload && !loading && (
        <p className="model-trial-preview__hint">可继续拖拽图片替换检测</p>
      )}
    </div>
  );
}
