"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Annotation, Category } from "@/lib/api";
import { moveBox, NormalizedBox as Box, resizeBox, ResizeHandle } from "@/lib/annotation-boxes";

type Props = {
  frameId: string;
  imageUrl: string;
  categories: Category[];
  annotations: Annotation[];
  taskType: "detect" | "classify";
  onSave: (annotations: Annotation[], status: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  darkCanvas?: boolean;
};

function annotationsToBoxes(annotations: Annotation[]): Box[] {
  return annotations
    .filter((a) => a.x_center != null)
    .map((a) => ({
      class_id: a.class_id,
      x_center: a.x_center!,
      y_center: a.y_center!,
      width: a.width!,
      height: a.height!,
    }));
}

export function AnnotationEditor({
  frameId,
  imageUrl,
  categories,
  annotations,
  taskType,
  onSave,
  onDirtyChange,
  darkCanvas,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [selectedClass, setSelectedClass] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{
    idx: number;
    mode: "move" | "resize";
    handle?: ResizeHandle;
    startX: number;
    startY: number;
    initial: Box;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [classLabel, setClassLabel] = useState<number | null>(annotations[0]?.class_id ?? null);
  const [imageReady, setImageReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const markDirty = useCallback(() => {
    setDirty(true);
    onDirtyChange?.(true);
  }, [onDirtyChange]);

  const clearDirty = useCallback(() => {
    setDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  // 切换图片时重置本地状态
  useEffect(() => {
    if (taskType === "detect") {
      setBoxes(annotationsToBoxes(annotations));
      setSelectedIdx(null);
    } else {
      setClassLabel(annotations[0]?.class_id ?? null);
    }
    clearDirty();
  }, [frameId, taskType, clearDirty]);

  // 轮询刷新后同步服务端标注（编辑中不覆盖）
  useEffect(() => {
    if (dirty) return;
    if (taskType === "detect") {
      setBoxes(annotationsToBoxes(annotations));
    } else {
      setClassLabel(annotations[0]?.class_id ?? null);
    }
  }, [annotations, dirty, taskType]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    boxes.forEach((b, i) => {
      const cat = categories.find((c) => c.class_id === b.class_id);
      const color = cat?.color || "#f97316";
      const x = (b.x_center - b.width / 2) * canvas.width;
      const y = (b.y_center - b.height / 2) * canvas.height;
      const w = b.width * canvas.width;
      const h = b.height * canvas.height;
      ctx.strokeStyle = i === selectedIdx ? "#fff" : color;
      ctx.lineWidth = i === selectedIdx ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color;
      ctx.font = "14px sans-serif";
      ctx.fillText(cat?.name || String(b.class_id), x, Math.max(14, y - 4));
      if (i === selectedIdx) {
        const points = [
          [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
          [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
        ];
        ctx.fillStyle = "#fff";
        points.forEach(([px, py]) => ctx.fillRect(px - 4, py - 4, 8, 8));
      }
    });

    if (drawing) {
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(drawing.x, drawing.y, 0, 0);
      ctx.setLineDash([]);
    }
  }, [boxes, categories, selectedIdx, drawing]);

  // 仅 imageUrl 变化时加载图片，避免框/选中状态变化触发重复下载
  useEffect(() => {
    setImageReady(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setImageReady(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // 图片就绪且 boxes 更新后再绘制，避免「有图无框」竞态
  useEffect(() => {
    if (!imageReady) return;
    draw();
  }, [imageReady, draw]);

  const hitTest = (mx: number, my: number, canvas: HTMLCanvasElement): { idx: number; handle?: ResizeHandle } | null => {
    const handles: [ResizeHandle, number, number][] = [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const x = (b.x_center - b.width / 2) * canvas.width;
      const y = (b.y_center - b.height / 2) * canvas.height;
      const w = b.width * canvas.width;
      const h = b.height * canvas.height;
      handles.push(
        ["nw", x, y], ["n", x + w / 2, y], ["ne", x + w, y],
        ["e", x + w, y + h / 2], ["se", x + w, y + h],
        ["s", x + w / 2, y + h], ["sw", x, y + h], ["w", x, y + h / 2],
      );
      const handle = handles.find(([, hx, hy]) => Math.abs(mx - hx) <= 10 && Math.abs(my - hy) <= 10);
      if (handle) return { idx: i, handle: handle[0] };
      if (mx >= x && mx <= x + w && my >= y && my <= y + h) return { idx: i };
      handles.length = 0;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const hit = hitTest(mx, my, canvas);
    if (hit !== null) {
      setSelectedIdx(hit.idx);
      setDrag({
        idx: hit.idx,
        mode: hit.handle ? "resize" : "move",
        handle: hit.handle,
        startX: mx,
        startY: my,
        initial: boxes[hit.idx],
      });
    } else {
      setSelectedIdx(null);
      setDrawing({ x: mx, y: my });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    if (drag) {
      const dx = (mx - drag.startX) / canvas.width;
      const dy = (my - drag.startY) / canvas.height;
      setBoxes((prev) =>
        prev.map((b, i) =>
          i !== drag.idx
            ? b
            : drag.mode === "move"
              ? moveBox(drag.initial, dx, dy)
              : resizeBox(
                  drag.initial,
                  drag.handle!,
                  Math.max(0, Math.min(1, mx / canvas.width)),
                  Math.max(0, Math.min(1, my / canvas.height)),
                  8 / canvas.width,
                  8 / canvas.height,
                )
        )
      );
      markDirty();
    } else if (drawing) {
      const ctx = canvas.getContext("2d");
      if (!ctx || !imgRef.current) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imgRef.current, 0, 0);
      boxes.forEach((b) => {
        const x = (b.x_center - b.width / 2) * canvas.width;
        const y = (b.y_center - b.height / 2) * canvas.height;
        const w = b.width * canvas.width;
        const h = b.height * canvas.height;
        ctx.strokeStyle = categories.find((c) => c.class_id === b.class_id)?.color || "#f97316";
        ctx.strokeRect(x, y, w, h);
      });
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(drawing.x, drawing.y, mx - drawing.x, my - drawing.y);
      ctx.setLineDash([]);
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * scaleX));
    const my = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * scaleY));

    if (drawing) {
      const x1 = Math.min(drawing.x, mx);
      const y1 = Math.min(drawing.y, my);
      const x2 = Math.max(drawing.x, mx);
      const y2 = Math.max(drawing.y, my);
      if (x2 - x1 > 8 && y2 - y1 > 8) {
        const w = (x2 - x1) / canvas.width;
        const h = (y2 - y1) / canvas.height;
        const xc = (x1 + x2) / 2 / canvas.width;
        const yc = (y1 + y2) / 2 / canvas.height;
        setBoxes((prev) => [...prev, { class_id: selectedClass, x_center: xc, y_center: yc, width: w, height: h }]);
        markDirty();
      }
      setDrawing(null);
      draw();
    }
    setDrag(null);
  };

  const deleteSelected = () => {
    if (selectedIdx === null) return;
    setBoxes((prev) => prev.filter((_, i) => i !== selectedIdx));
    setSelectedIdx(null);
    markDirty();
    draw();
  };

  const clearAll = () => {
    setBoxes([]);
    setSelectedIdx(null);
    markDirty();
    draw();
  };

  const toPayload = (): Annotation[] =>
    boxes.map((b) => ({
      class_id: b.class_id,
      x_center: b.x_center,
      y_center: b.y_center,
      width: b.width,
      height: b.height,
      confidence: 1,
    }));

  const save = async (status: string) => {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      if (taskType === "classify") {
        await onSave(classLabel !== null ? [{ class_id: classLabel }] : [], status);
      } else {
        await onSave(toPayload(), status);
      }
      clearDirty();
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "y" || e.key === "Y") void save("human_ok");
      if (e.key === "n" || e.key === "N") void save("human_wrong");
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "0") void save("no_target");
      if (e.key >= "1" && e.key <= "9") {
        const classId = Number(e.key) - 1;
        if (categories.some((c) => c.class_id === classId)) setSelectedClass(classId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  if (taskType === "classify") {
    return (
      <div>
        <img src={imageUrl} alt="frame" className="mb-4 max-h-96 rounded-lg" />
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c.class_id}
              className={`btn ${classLabel === c.class_id ? "btn-primary" : "btn-secondary"}`}
              onClick={() => { setClassLabel(c.class_id); markDirty(); }}
            >
              {c.name}
            </button>
          ))}
          <button className="btn-secondary" disabled={saving} onClick={() => void save("no_target")}>无目标</button>
        </div>
        {saveError && <p className="mt-3 text-sm text-red-600">保存失败，修改已保留：{saveError}</p>}
        <div className="mt-4 flex gap-2">
          <button className="btn-primary" disabled={saving} onClick={() => void save("human_ok")}>{saving ? "保存中…" : "Y 确认 (保存)"}</button>
          <button className="btn-secondary" disabled={saving} onClick={() => void save("human_wrong")}>N 驳回</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {categories.map((c) => (
          <button
            key={c.class_id}
            className={`btn text-xs ${selectedClass === c.class_id ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedClass(c.class_id)}
            style={{ borderColor: c.color }}
          >
            {c.name}
          </button>
        ))}
        <button
          className="btn-secondary text-xs"
          onClick={deleteSelected}
          disabled={selectedIdx === null}
          title={selectedIdx === null ? "请先点击选中一个框" : undefined}
        >
          删除选中框 (Del)
        </button>
        <button className="btn-secondary text-xs" onClick={clearAll} disabled={boxes.length === 0}>
          清除全部框
        </button>
      </div>
      {dirty && (
        <p className="mb-2 text-xs text-amber-400">有未保存修改 · 完成后请点「Y 确认 (保存)」</p>
      )}
      {selectedIdx !== null && (
        <p className="mb-2 text-xs text-slate-400">已选中第 {selectedIdx + 1} 个框（白边）· Del 删除</p>
      )}
      <div className="relative">
        {!imageReady && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900/80 text-sm text-slate-400">
            加载图片…
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`max-h-[60vh] w-full cursor-crosshair rounded-lg border ${darkCanvas ? "border-slate-600" : "border-slate-700"}`}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { setDrawing(null); setDrag(null); }}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary" disabled={saving} onClick={() => void save("human_ok")}>{saving ? "保存中…" : "Y 确认 (保存)"}</button>
        <button className="btn-secondary" disabled={saving} onClick={() => void save("human_wrong")}>N 驳回 (保存)</button>
        <button className="btn-secondary" disabled={saving} onClick={() => void save("no_target")}>无目标</button>
      </div>
      {saveError && <p className="mt-2 text-sm text-red-500">保存失败，修改已保留：{saveError}</p>}
      <p className="mt-2 text-xs text-slate-500">
        操作：空白处拖拽画新框 · 拖动框移动 · 拖动八个白色控制点缩放 · 快捷键 Y/N/Del
      </p>
    </div>
  );
}
