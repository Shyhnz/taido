/**
 * The handle on the left edge of a right-hand panel (task panel, « Demander au projet »):
 * drag it, or ←/→ (⇧ for bigger steps) once focused, to change the panel's width.
 */

import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { t } from "../../i18n";
import { PANEL_MIN } from "./panelWidth";

export function ResizeHandle({
  width,
  max,
  onResize,
  onCommit,
  label = t.panel.resize,
}: {
  width: number;
  max: number;
  onResize: (w: number) => void;
  onCommit: (w: number) => void;
  /** Accessible name (« Redimensionner le panneau » by default). */
  label?: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onResize(start.current.width + (start.current.x - e.clientX));
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    onCommit(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onCommit(width + (e.key === "ArrowLeft" ? step : -step));
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused and dragged
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.min(PANEL_MIN, max)}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/20 focus-visible:bg-accent/30"
    />
  );
}
