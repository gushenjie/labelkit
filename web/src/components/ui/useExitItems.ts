"use client";

import { useEffect, useState } from "react";
import { motion, reducedMotion } from "./motion";

/** Retain removed rows in their original slots for one non-interactive exit. */
export function useExitItems<T extends { id: string }>(items: T[], resetKey = "") {
  const [state, setState] = useState({ input: items, key: resetKey, entries: items.map(item => ({ item, exiting: false })) });
  if (state.input !== items || state.key !== resetKey) {
    const entries = items.map(item => ({ item, exiting: false }));
    if (state.key === resetKey && !reducedMotion()) state.entries.forEach(({ item, exiting }, index) => {
      if (!exiting && !items.some(next => next.id === item.id)) entries.splice(Math.min(index, entries.length), 0, { item, exiting: true });
    });
    setState({ input: items, key: resetKey, entries });
  }
  useEffect(() => {
    if (!state.entries.some(entry => entry.exiting)) return;
    const timer = window.setTimeout(() => setState(current => ({ ...current, entries: current.entries.filter(entry => !entry.exiting) })), motion.exit);
    return () => window.clearTimeout(timer);
  }, [state.entries]);
  return state.entries;
}
