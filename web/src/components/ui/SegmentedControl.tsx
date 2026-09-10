"use client";

import { useLayoutEffect, useRef } from "react";
import { motion, reducedMotion } from "./motion";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({ options, value, onChange, disabled }: Props<T>) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const selected = root.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    const rect = selected.getBoundingClientRect(), old = previous.current;
    previous.current = rect;
    if (!old || reducedMotion() || old.left === rect.left) return;
    // Move only the selection underline, never the label or click target.
    const indicator = selected.querySelector("i");
    const animation = indicator?.animate([{ transform: `translateX(${old.left - rect.left}px)` }, { transform: "translateX(0)" }], { duration: motion.enter, easing: motion.ease });
    return () => animation?.cancel();
  }, [value]);
  return (
    <div ref={root} className="segmented-control" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          tabIndex={value === opt.value ? 0 : -1}
          className={value === opt.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          onKeyDown={event => {
            const index = options.findIndex(item => item.value === opt.value);
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowRight" ? (index + 1) % options.length : event.key === "ArrowLeft" ? (index - 1 + options.length) % options.length : -1;
            if (next >= 0 && !disabled) { event.preventDefault(); onChange(options[next].value); root.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus(); }
          }}
        >
          {opt.label}
          {value === opt.value && <i aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
