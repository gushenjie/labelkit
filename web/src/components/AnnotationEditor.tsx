"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Annotation, Category } from "@/lib/api";
import { Icon } from "@/components/Icon";
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
  compact?: boolean;
  /** 复查页右侧面板挂载点，传入后标注列表与缩放控件显示在侧栏 */
  sidePanel?: HTMLElement | null;
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

type EditorMode = "view" | "annotate";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(18, 168, 143, ${alpha})`;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  selected: boolean,
  label: string,
) {
  if (selected) {
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  const fontSize = Math.max(12, Math.min(14, h * 0.35));
  ctx.font = `600 ${fontSize}px sans-serif`;
  const textY = Math.max(fontSize, y - 6);
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = selected ? "rgba(15, 23, 42, 0.78)" : hexToRgba(color, 0.82);
  ctx.fillRect(x, textY - fontSize, textWidth + 10, fontSize + 6);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, x + 5, textY);

  if (selected && w >= 14 && h >= 14) {
    const radius = Math.min(5, Math.max(3, Math.min(w, h) / 10));
    const points = [
      [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
      [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
    ];
    points.forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function applyCanvasDisplay(
  canvas: HTMLCanvasElement,
  imageWidth: number,
  imageHeight: number,
  bounds: HTMLElement | null,
  userZoom: number,
) {
  const maxWidth = bounds?.clientWidth ?? imageWidth;
  const maxHeight = bounds?.clientHeight ?? Math.min(window.innerHeight * 0.6, 720);
  if (maxWidth <= 0 || maxHeight <= 0) return 1;
  const fitScale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
  const scale = fitScale * userZoom;
  canvas.style.width = `${Math.round(imageWidth * scale)}px`;
  canvas.style.height = `${Math.round(imageHeight * scale)}px`;
  return fitScale;
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
  compact = false,
  sidePanel = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fitScaleRef = useRef(1);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [selectedClass, setSelectedClass] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [userZoom, setUserZoom] = useState(1);
  const [editorMode, setEditorMode] = useState<EditorMode>(compact ? "view" : "annotate");
  const [pan, setPan] = useState<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const panMovedRef = useRef(false);
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

  const updateCanvasDisplay = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    fitScaleRef.current = applyCanvasDisplay(
      canvas,
      img.naturalWidth,
      img.naturalHeight,
      stageRef.current,
      userZoom,
    );
  }, [userZoom]);

  const scrollToBox = useCallback((box: Box, zoom: number) => {
    const viewport = viewportRef.current;
    const img = imgRef.current;
    if (!viewport || !img) return;
    requestAnimationFrame(() => {
      const displayW = img.naturalWidth * fitScaleRef.current * zoom;
      const displayH = img.naturalHeight * fitScaleRef.current * zoom;
      const cx = box.x_center * displayW;
      const cy = box.y_center * displayH;
      viewport.scrollLeft = Math.max(0, cx - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, cy - viewport.clientHeight / 2);
    });
  }, []);

  const zoomToBox = useCallback((box: Box) => {
    const viewport = viewportRef.current;
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!viewport || !img || !stage) return;
    const fitScale = Math.min(
      stage.clientWidth / img.naturalWidth,
      stage.clientHeight / img.naturalHeight,
      1,
    );
    const boxW = box.width * img.naturalWidth * fitScale;
    const boxH = box.height * img.naturalHeight * fitScale;
    const targetFill = 0.42;
    const zoomW = (viewport.clientWidth * targetFill) / Math.max(boxW, 1);
    const zoomH = (viewport.clientHeight * targetFill) / Math.max(boxH, 1);
    const nextZoom = clamp(Math.min(zoomW, zoomH), 1, 8);
    setUserZoom(nextZoom);
    scrollToBox(box, nextZoom);
  }, [scrollToBox]);

  const focusBox = useCallback((index: number | null) => {
    if (index === null || !boxes[index]) return;
    zoomToBox(boxes[index]);
  }, [boxes, zoomToBox]);

  // 切换图片时重置本地状态
  useEffect(() => {
    setUserZoom(1);
    setEditorMode(compact ? "view" : "annotate");
    setPan(null);
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
      drawBox(ctx, x, y, w, h, color, i === selectedIdx, cat?.name || String(b.class_id));
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
    let cancelled = false;
    setImageReady(false);
    setUserZoom(1);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        fitScaleRef.current = applyCanvasDisplay(
          canvas,
          img.naturalWidth,
          img.naturalHeight,
          stageRef.current,
          1,
        );
      }
      setImageReady(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      imgRef.current = null;
      setImageReady(false);
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageReady || !imgRef.current) return;
    const refit = () => updateCanvasDisplay();
    refit();
    const observerTargets = [stageRef.current, viewportRef.current].filter(Boolean) as HTMLElement[];
    const observer = new ResizeObserver(refit);
    observerTargets.forEach((target) => observer.observe(target));
    window.addEventListener("resize", refit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refit);
    };
  }, [imageReady, imageUrl, updateCanvasDisplay]);

  // 图片就绪且 boxes 更新后再绘制，避免「有图无框」竞态
  useEffect(() => {
    if (!imageReady) return;
    draw();
    updateCanvasDisplay();
  }, [imageReady, draw, updateCanvasDisplay]);

  useEffect(() => {
    if (!pan) return;
    const onMove = (e: MouseEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMovedRef.current = true;
      viewport.scrollLeft = pan.scrollLeft - dx;
      viewport.scrollTop = pan.scrollTop - dy;
    };
    const onUp = (e: MouseEvent) => {
      if (editorMode === "view" && !panMovedRef.current && canvasRef.current) {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        if (
          e.clientX >= rect.left && e.clientX <= rect.right
          && e.clientY >= rect.top && e.clientY <= rect.bottom
        ) {
          const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
          const my = (e.clientY - rect.top) * (canvas.height / rect.height);
          const hit = hitTest(mx, my, canvas);
          setSelectedIdx(hit?.idx ?? null);
        }
      }
      setPan(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [pan, editorMode, boxes]);

  const hitTest = (mx: number, my: number, canvas: HTMLCanvasElement): { idx: number; handle?: ResizeHandle } | null => {
    const rect = canvas.getBoundingClientRect();
    const minHitPx = 28;
    const minHitW = (minHitPx / Math.max(rect.width, 1)) * canvas.width;
    const minHitH = (minHitPx / Math.max(rect.height, 1)) * canvas.height;
    const handleSlop = Math.max(10, minHitPx / 2);

    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const x = (b.x_center - b.width / 2) * canvas.width;
      const y = (b.y_center - b.height / 2) * canvas.height;
      const w = b.width * canvas.width;
      const h = b.height * canvas.height;
      const handles: [ResizeHandle, number, number][] = [
        ["nw", x, y], ["n", x + w / 2, y], ["ne", x + w, y],
        ["e", x + w, y + h / 2], ["se", x + w, y + h],
        ["s", x + w / 2, y + h], ["sw", x, y + h], ["w", x, y + h / 2],
      ];
      const handle = handles.find(([, hx, hy]) => Math.abs(mx - hx) <= handleSlop && Math.abs(my - hy) <= handleSlop);
      if (handle) return { idx: i, handle: handle[0] };

      const hitW = Math.max(w, minHitW);
      const hitH = Math.max(h, minHitH);
      const hitX = b.x_center * canvas.width - hitW / 2;
      const hitY = b.y_center * canvas.height - hitH / 2;
      if (mx >= hitX && mx <= hitX + hitW && my >= hitY && my <= hitY + hitH) return { idx: i };
    }
    return null;
  };

  const onViewportPanStart = (e: React.MouseEvent) => {
    const viewport = viewportRef.current;
    if (!viewport || editorMode !== "view") return;
    e.preventDefault();
    panMovedRef.current = false;
    setPan({
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (editorMode === "view") return;
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
        const color = categories.find((c) => c.class_id === b.class_id)?.color || "#f97316";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
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
        setBoxes((prev) => {
          const next = [...prev, { class_id: selectedClass, x_center: xc, y_center: yc, width: w, height: h }];
          setSelectedIdx(next.length - 1);
          return next;
        });
        markDirty();
      }
      setDrawing(null);
      draw();
    }
    setDrag(null);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const oldZoom = userZoom;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const nextZoom = clamp(oldZoom * factor, 0.25, 8);
    if (nextZoom === oldZoom) return;
    const rect = viewport.getBoundingClientRect();
    const cursorX = e.clientX - rect.left + viewport.scrollLeft;
    const cursorY = e.clientY - rect.top + viewport.scrollTop;
    setUserZoom(nextZoom);
    requestAnimationFrame(() => {
      const ratio = nextZoom / oldZoom;
      viewport.scrollLeft = cursorX * ratio - (e.clientX - rect.left);
      viewport.scrollTop = cursorY * ratio - (e.clientY - rect.top);
    });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const hit = hitTest(mx, my, canvas);
    if (hit !== null) {
      setSelectedIdx(hit.idx);
      zoomToBox(boxes[hit.idx]);
      return;
    }
    if (editorMode === "view") setEditorMode("annotate");
  };

  // 单框时自动选中，便于删除/调整
  useEffect(() => {
    if (taskType !== "detect" || boxes.length !== 1) return;
    setSelectedIdx(0);
  }, [frameId, boxes.length, taskType]);

  const deleteBoxAt = useCallback((index: number) => {
    setBoxes((prev) => prev.filter((_, i) => i !== index));
    setSelectedIdx((current) => {
      if (current === null) return null;
      if (current === index) return null;
      if (current > index) return current - 1;
      return current;
    });
    markDirty();
  }, [markDirty]);

  const deleteSelected = useCallback(() => {
    if (selectedIdx === null) return;
    deleteBoxAt(selectedIdx);
  }, [deleteBoxAt, selectedIdx]);

  const clearAll = () => {
    setBoxes([]);
    setSelectedIdx(null);
    markDirty();
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

      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        void save("human_ok");
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void save("human_wrong");
        return;
      }
      if (e.key === "o" || e.key === "O" || e.key === "0") {
        e.preventDefault();
        void save("no_target");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setUserZoom((z) => clamp(z * 1.2, 0.25, 8));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setUserZoom((z) => clamp(z / 1.2, 0.25, 8));
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        focusBox(selectedIdx ?? (boxes.length > 0 ? 0 : null));
        return;
      }
      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        setEditorMode("view");
        return;
      }
      if (e.key === "m" || e.key === "M" || e.key === "a" || e.key === "A") {
        e.preventDefault();
        setEditorMode("annotate");
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const classId = Number(e.key) - 1;
        if (categories.some((c) => c.class_id === classId)) setSelectedClass(classId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [boxes, categories, deleteSelected, focusBox, save, selectedIdx]);

  const useSidePanel = compact && !!sidePanel;

  const boxList = boxes.length > 0 ? (
    <ul className="annotation-side-panel__list" aria-label="当前标注列表">
      {boxes.map((b, i) => {
        const cat = categories.find((c) => c.class_id === b.class_id);
        return (
          <li
            key={`${frameId}-${i}-${b.x_center}-${b.y_center}`}
            className={selectedIdx === i ? "annotation-side-panel__item annotation-side-panel__item--active" : "annotation-side-panel__item"}
          >
            <button
              type="button"
              className="annotation-side-panel__item-label"
              onClick={() => setSelectedIdx(i)}
            >
              <span className="annotation-side-panel__item-index">{i + 1}</span>
              <span>{cat?.name ?? `类别${b.class_id}`}</span>
            </button>
            <button
              type="button"
              className="annotation-side-panel__item-delete"
              onClick={() => deleteBoxAt(i)}
              aria-label={`删除${cat?.name ?? "标注"}${i + 1}`}
            >
              删除
            </button>
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="annotation-side-panel__empty">暂无标注框 · 在图上拖拽可新建</p>
  );

  const inlineBoxChips = boxes.length > 0 ? (
    <div className="annotation-editor__box-list" role="list" aria-label="当前标注列表">
      {boxes.map((b, i) => {
        const cat = categories.find((c) => c.class_id === b.class_id);
        return (
          <span
            key={`${frameId}-${i}-${b.x_center}-${b.y_center}`}
            className={selectedIdx === i ? "annotation-editor__box-chip annotation-editor__box-chip--active" : "annotation-editor__box-chip"}
            role="listitem"
          >
            <button type="button" className="annotation-editor__box-chip-label" onClick={() => setSelectedIdx(i)}>
              {cat?.name ?? `类别${b.class_id}`}
            </button>
            <button type="button" className="annotation-editor__box-chip-delete" onClick={() => deleteBoxAt(i)} aria-label={`删除${cat?.name ?? "标注"}${i + 1}`}>
              ×
            </button>
          </span>
        );
      })}
    </div>
  ) : null;

  const inlineZoomControls = (
    <div className="annotation-editor__zoom" role="group" aria-label="画布缩放">
      <button type="button" className="btn-secondary text-xs" onClick={() => setUserZoom((z) => clamp(z / 1.25, 0.25, 8))} title="缩小">−</button>
      <button type="button" className="btn-secondary text-xs annotation-editor__zoom-label" onClick={() => setUserZoom(1)} title="重置缩放">
        {Math.round(userZoom * 100)}%
      </button>
      <button type="button" className="btn-secondary text-xs" onClick={() => setUserZoom((z) => clamp(z * 1.25, 0.25, 8))} title="放大">+</button>
    </div>
  );

  const sidePanelContent = useSidePanel ? (
    <div className="annotation-side-panel">
      <div className="annotation-side-panel__section">
        <div className="annotation-side-panel__section-head">
          <span className="project-section-kicker">当前标注</span>
          <button
            type="button"
            className="annotation-side-panel__clear-all"
            onClick={clearAll}
            disabled={boxes.length === 0}
            title="清除全部框"
            aria-label="清除全部框"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
        {boxList}
      </div>
    </div>
  ) : null;

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
          <button className="btn-secondary" disabled={saving} onClick={() => void save("no_target")}>O 无目标</button>
        </div>
        {saveError && <p className="mt-3 text-sm text-red-600">保存失败，修改已保留：{saveError}</p>}
        <div className="mt-4 flex gap-2">
          <button className="btn-primary" disabled={saving} onClick={() => void save("human_ok")}>{saving ? "保存中…" : "Y 确认"}</button>
          <button className="btn-secondary" disabled={saving} onClick={() => void save("human_wrong")}>N 驳回</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {sidePanelContent && sidePanel ? createPortal(sidePanelContent, sidePanel) : null}
      <div className={compact ? "annotation-editor annotation-editor--compact" : "annotation-editor"}>
      <div className={compact ? "annotation-editor__toolbar annotation-editor__toolbar--compact" : "mb-3 flex flex-wrap items-center gap-2"}>
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
        {useSidePanel && (
          <div className="annotation-editor__mode annotation-editor__mode--compact" role="group" aria-label="编辑模式">
            <button type="button" className={`btn text-xs ${editorMode === "view" ? "btn-primary" : "btn-secondary"}`} onClick={() => setEditorMode("view")}>V 查看</button>
            <button type="button" className={`btn text-xs ${editorMode === "annotate" ? "btn-primary" : "btn-secondary"}`} onClick={() => setEditorMode("annotate")}>A 标注</button>
          </div>
        )}
        {!useSidePanel && (
          <>
            <div className="annotation-editor__mode" role="group" aria-label="编辑模式">
              <button type="button" className={`btn text-xs ${editorMode === "view" ? "btn-primary" : "btn-secondary"}`} onClick={() => setEditorMode("view")}>V 查看</button>
              <button type="button" className={`btn text-xs ${editorMode === "annotate" ? "btn-primary" : "btn-secondary"}`} onClick={() => setEditorMode("annotate")}>A 标注</button>
            </div>
            <button
              className="btn-secondary text-xs"
              onClick={deleteSelected}
              disabled={selectedIdx === null && boxes.length === 0}
              title={selectedIdx === null ? "点击选中框，或从下方列表删除" : "删除当前选中的框"}
            >
              删除选中框 (Del)
            </button>
            <button className="btn-secondary text-xs" onClick={clearAll} disabled={boxes.length === 0}>
              清除全部框
            </button>
            {inlineBoxChips}
            {inlineZoomControls}
          </>
        )}
      </div>
      {dirty && !compact && (
        <p className="mb-2 text-xs text-amber-400">有未保存修改 · 完成后请点「Y 确认 (保存)」</p>
      )}
      <div ref={stageRef} className="annotation-editor__stage relative">
        {!imageReady && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900/80 text-sm text-slate-400">
            加载图片…
          </div>
        )}
        <div
          ref={viewportRef}
          className={[
            "annotation-editor__viewport",
            editorMode === "view" ? (pan ? "annotation-editor__viewport--panning" : "annotation-editor__viewport--view") : "",
          ].filter(Boolean).join(" ")}
          onWheel={onWheel}
          onMouseDown={onViewportPanStart}
        >
          <div className="annotation-editor__viewport-center">
            <canvas
              ref={canvasRef}
              className={`annotation-editor__canvas rounded-lg border ${editorMode === "annotate" ? "cursor-crosshair" : ""} ${darkCanvas ? "border-slate-600" : "border-slate-700"}`}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onDoubleClick={onDoubleClick}
              onMouseLeave={() => { if (editorMode === "annotate") { setDrawing(null); setDrag(null); } }}
            />
          </div>
        </div>
      </div>
      <div className={compact ? "annotation-editor__actions" : "mt-4 flex flex-wrap gap-2"}>
        <button className="btn-primary" disabled={saving} onClick={() => void save("human_ok")}>{saving ? "保存中…" : "Y 确认"}</button>
        <button className="btn-secondary" disabled={saving} onClick={() => void save("human_wrong")}>N 驳回</button>
        <button className="btn-secondary" disabled={saving} onClick={() => void save("no_target")}>O 无目标</button>
      </div>
      {saveError && <p className="mt-2 text-sm text-red-500">保存失败，修改已保留：{saveError}</p>}
      <p className={compact ? "annotation-editor__shortcuts" : "mt-2 text-xs text-slate-500"}>
        快捷键：Y 确认 · O 无目标 · N 驳回 · V 查看 · A 标注 · ←→ 翻页 · Del 删框
      </p>
      {!compact && (
      <p className="mt-1 text-xs text-slate-500">
        操作：滚轮缩放 · 双击框放大 · 空白处拖拽画新框 · 1-9 选类别
      </p>
      )}
    </div>
    </>
  );
}
