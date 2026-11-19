import { useCallback, useRef, useState } from "react";

const LIMIT = 200;
const MERGE_MS = 1000;

export interface CommitOptions {
  /** Consecutive commits with the same key within a second become one undo step (typing, nudging). */
  key?: string;
  /** Fold this change into the current step instead of creating one (automatic adjustments). */
  replace?: boolean;
}

/** Undo/redo history over an immutable value. */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState<{ past: T[]; present: T; future: T[] }>({ past: [], present: initial, future: [] });
  const last = useRef<{ key?: string; at: number }>({ at: 0 });

  const commit = useCallback((update: (current: T) => T, opts: CommitOptions = {}) => {
    const now = Date.now();
    const merge = opts.replace || (opts.key !== undefined && last.current.key === opts.key && now - last.current.at < MERGE_MS);
    if (!opts.replace) last.current = { key: opts.key, at: now };
    setState((s) => {
      const next = update(s.present);
      if (next === s.present) return s;
      if (merge) return { ...s, present: next, future: opts.replace ? s.future : [] };
      return { past: [...s.past.slice(-(LIMIT - 1)), s.present], present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    last.current = { at: 0 };
    setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s));
  }, []);

  const redo = useCallback(() => {
    last.current = { at: 0 };
    setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s));
  }, []);

  return { present: state.present, commit, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
