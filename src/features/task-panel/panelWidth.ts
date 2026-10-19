/**
 * Width of the task panel: ~460 px by default, resizable,
 * remembered, and always capped to the space left by the sidebar and a minimal list so the
 * header (and its ×) is never cut off, also when the window shrinks (bug #7).
 *
 * The width is remembered in `localStorage`: the core setting `panel_width` is still clamped to
 * 560–1000 px (old two-column panel).
 */

import { useCallback, useEffect, useState } from "react";

export const PANEL_MIN = 360;
export const PANEL_MAX = 1000;
export const PANEL_DEFAULT = 460;
/** Sidebar width. */
export const SIDEBAR_WIDTH = 248;
/** The list never gets narrower than this while the panel is open. */
export const LIST_MIN = 320;

const STORAGE_KEY = "todo.panelWidth";

/** Largest width the panel may take in a window `viewport` px wide. */
export function maxPanelWidth(viewport: number): number {
  const room = viewport - SIDEBAR_WIDTH;
  const comfortable = room - LIST_MIN;
  // Below the minimum, give up the list rather than the panel header.
  return Math.max(
    0,
    Math.min(PANEL_MAX, Math.max(comfortable, Math.min(PANEL_MIN, room))),
  );
}

/** Width actually shown: the wanted width clamped to the bounds and to the window. */
export function fitPanelWidth(width: number, viewport: number): number {
  const max = maxPanelWidth(viewport);
  const wanted = Number.isFinite(width) ? width : PANEL_DEFAULT;
  return Math.round(Math.min(max, Math.max(PANEL_MIN, wanted)));
}

/** A right-hand panel whose width is remembered: its storage key and default width. */
export interface PanelKind {
  key: string;
  fallback: number;
}

export const TASK_PANEL: PanelKind = {
  key: STORAGE_KEY,
  fallback: PANEL_DEFAULT,
};
/** « Demander au projet » (2026-10-15): its own width, 420 px by default like the mock-up. */
export const ASK_PANEL: PanelKind = {
  key: "todo.askPanelWidth",
  fallback: 420,
};

export function readPanelWidth(kind: PanelKind = TASK_PANEL): number {
  try {
    const raw = window.localStorage.getItem(kind.key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : kind.fallback;
  } catch {
    return kind.fallback;
  }
}

export function writePanelWidth(
  width: number,
  kind: PanelKind = TASK_PANEL,
): void {
  try {
    window.localStorage.setItem(kind.key, String(Math.round(width)));
  } catch {
    // Storage unavailable (private mode): the width just isn't remembered.
  }
}

/**
 * Returns the shown width, the maximum for the current window, a setter used while dragging
 * and `commit` to remember a width.
 */
export function usePanelWidth(kind: PanelKind = TASK_PANEL): {
  width: number;
  max: number;
  setWidth: (w: number) => void;
  commit: (w: number) => void;
} {
  const [wanted, setWanted] = useState(() => readPanelWidth(kind));
  const [viewport, setViewport] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = fitPanelWidth(wanted, viewport);
  const setWidth = useCallback(
    (w: number) => setWanted(fitPanelWidth(w, window.innerWidth)),
    [],
  );
  const commit = useCallback(
    (w: number) => {
      const fitted = fitPanelWidth(w, window.innerWidth);
      setWanted(fitted);
      writePanelWidth(fitted, kind);
    },
    [kind],
  );

  return { width, max: maxPanelWidth(viewport), setWidth, commit };
}
