/**
 * Deferred saving of the panel's text fields (bug #2): a value is sent ~600 ms after the last
 * keystroke, and every pending value is flushed when the panel closes, when another task
 * opens (the panel remounts), and when the window unloads (⌘Q, reload).
 */

import { useEffect, useMemo, useRef } from "react";

export const SAVE_DELAY_MS = 600;

/** Pending flushes of every mounted field, so actions (delete…) can flush first. */
const flushers = new Set<() => void>();

/** Sends every pending panel edit now. */
export function flushPanelEdits(): void {
  for (const flush of Array.from(flushers)) flush();
}

export interface DebouncedSave {
  /** Remembers `value` and sends it after the delay (restarted on each call). */
  schedule: (value: string) => void;
  /** Sends the pending value now, if any. */
  flush: () => void;
  /** Drops the pending value. */
  cancel: () => void;
}

/**
 * `save` is read at send time (latest closure). The pending value is flushed on unmount and on
 * `beforeunload` / `pagehide`.
 */
export function useDebouncedSave(
  save: (value: string) => void,
  delay: number = SAVE_DELAY_MS,
): DebouncedSave {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ value: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = useMemo<DebouncedSave>(() => {
    const clear = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const flush = () => {
      clear();
      const p = pending.current;
      pending.current = null;
      if (p) saveRef.current(p.value);
    };
    return {
      schedule: (value) => {
        pending.current = { value };
        clear();
        timer.current = setTimeout(flush, delay);
      },
      flush,
      cancel: () => {
        clear();
        pending.current = null;
      },
    };
  }, [delay]);

  useEffect(() => {
    flushers.add(api.flush);
    window.addEventListener("beforeunload", api.flush);
    window.addEventListener("pagehide", api.flush);
    return () => {
      flushers.delete(api.flush);
      window.removeEventListener("beforeunload", api.flush);
      window.removeEventListener("pagehide", api.flush);
      api.flush();
    };
  }, [api]);

  return api;
}
