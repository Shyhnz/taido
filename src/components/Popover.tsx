/**
 * Non-modal popover anchored under an element (date picker of the task panel). Fixed position
 * clamped to the window, flipped above when there is no room below. Closes on Escape (focus
 * back to the anchor), on a click outside, and on window resize.
 */

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const MARGIN = 8;

export function Popover({
  anchorRef,
  label,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name of the popover. */
  label: string;
  /** `restoreFocus` is true when the anchor should get the focus back. */
  onClose: (restoreFocus: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = Math.min(a.left, window.innerWidth - r.width - MARGIN);
    left = Math.max(MARGIN, left);
    let top = a.bottom + GAP;
    if (top + r.height > window.innerHeight - MARGIN) {
      const above = a.top - GAP - r.height;
      top =
        above >= MARGIN
          ? above
          : Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
    }
    setPos({ left, top });
    const first =
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      el.querySelector<HTMLElement>("button:not(:disabled), input");
    first?.focus();
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // The anchor toggles the popover itself.
      if (anchorRef.current?.contains(target)) return;
      // Let a field inside commit its draft (its blur handler) before the popover goes away.
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) {
        active.blur();
      }
      onCloseRef.current(false);
    };
    const onResize = () => onCloseRef.current(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchorRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    // Keys typed in the popover never reach the list shortcuts (j, k, q…); ⌘ ones still do.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="fixed z-50 rounded-lg border border-border bg-elevated shadow-pop"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
