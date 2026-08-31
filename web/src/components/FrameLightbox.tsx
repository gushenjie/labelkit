"use client";

import { useCallback, useEffect } from "react";
import { api, Frame } from "@/lib/api";
import { FRAME_STATUS_SIMPLE } from "@/lib/status";
import { Icon } from "@/components/Icon";

type Props = {
  open: boolean;
  frames: Frame[];
  index: number;
  projectId: string;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  onReview?: (frame: Frame) => void;
};

export function FrameLightbox({ open, frames, index, projectId, onClose, onIndexChange, onReview }: Props) {
  const frame = frames[index];
  const total = frames.length;

  const goPrev = useCallback(() => {
    if (total === 0) return;
    onIndexChange((index - 1 + total) % total);
  }, [index, total, onIndexChange]);

  const goNext = useCallback(() => {
    if (total === 0) return;
    onIndexChange((index + 1) % total);
  }, [index, total, onIndexChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, goPrev, goNext]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open || !frame) return null;

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="标注图片预览"
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-200">{frame.filename}</p>
            <p className="text-xs text-slate-500">
              {index + 1} / {total}
              <span className="mx-2">·</span>
              {FRAME_STATUS_SIMPLE[frame.status] ?? frame.status}
              {frame.annotations.length > 0 && (
                <span className="mx-2">·</span>
              )}
              {frame.annotations.length > 0 && `${frame.annotations.length} 个框`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onReview && (
              <button
                type="button"
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                onClick={() => onReview(frame)}
              >
                进入人工复查
              </button>
            )}
            <button
              type="button"
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              onClick={onClose}
              aria-label="关闭"
            >
              <Icon name="x" size={18} />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-2">
          {total > 1 && (
            <button
              type="button"
              className="absolute left-2 z-10 rounded-full bg-slate-900/80 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={goPrev}
              aria-label="上一张"
            >
              <Icon name="chevron-left" size={22} />
            </button>
          )}
          <img
            src={api.frameImageUrl(projectId, frame.id, true)}
            alt={frame.filename}
            className="max-h-[calc(92vh-120px)] max-w-full object-contain"
          />
          {total > 1 && (
            <button
              type="button"
              className="absolute right-2 z-10 rounded-full bg-slate-900/80 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={goNext}
              aria-label="下一张"
            >
              <Icon name="chevron-right" size={22} />
            </button>
          )}
        </div>

        {total > 1 && (
          <footer className="shrink-0 border-t border-slate-800 px-4 py-2 text-center text-xs text-slate-500">
            ← → 翻页 · Esc 关闭
          </footer>
        )}
      </div>
    </div>
  );
}
