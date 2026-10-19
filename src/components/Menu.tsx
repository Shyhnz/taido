/**
 * Context menus and dropdown menus: one global host, opened with `openMenu`.
 * Keyboard: ↑/↓ move, Enter activates, Escape closes and restores focus.
 */

import { Check } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      disabled?: boolean;
      /** Muted text on the right (shortcut, submenu arrow…). */
      hint?: string;
      /** Muted line under the label. */
      description?: string;
      danger?: boolean;
      checked?: boolean;
    }
  | { separator: true };

interface MenuState {
  menu: {
    x: number;
    y: number;
    items: MenuItem[];
    label: string;
    /** `x` is the right edge of the menu instead of its left edge. */
    alignRight: boolean;
    returnFocus: HTMLElement | null;
  } | null;
  open: (
    x: number,
    y: number,
    items: MenuItem[],
    label: string,
    alignRight?: boolean,
  ) => void;
  close: () => void;
}

export const useMenuStore = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items, label, alignRight = false) =>
    set({
      menu: {
        x,
        y,
        items,
        label,
        alignRight,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      },
    }),
  close: () => set({ menu: null }),
}));

/** Opens a context menu at the pointer. */
export function openContextMenu(
  event: ReactMouseEvent,
  items: MenuItem[],
  label: string,
): void {
  event.preventDefault();
  event.stopPropagation();
  useMenuStore.getState().open(event.clientX, event.clientY, items, label);
}

/** Opens a dropdown menu under an element (aligned on its right edge when `alignRight`). */
export function openMenuAt(
  element: HTMLElement,
  items: MenuItem[],
  label: string,
  alignRight = false,
): void {
  const rect = element.getBoundingClientRect();
  useMenuStore
    .getState()
    .open(
      alignRight ? rect.right : rect.left,
      rect.bottom + 4,
      items,
      label,
      alignRight,
    );
}

export function isMenuOpen(): boolean {
  return useMenuStore.getState().menu !== null;
}

export function MenuHost() {
  const menu = useMenuStore((s) => s.menu);
  const close = useMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const rect = ref.current.getBoundingClientRect();
    const width = rect.width || 220;
    const height = rect.height || 0;
    let left = menu.alignRight ? menu.x - width : menu.x;
    let top = menu.y;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - height - 8);
    }
    setPos({ left, top });
    const first = ref.current.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    first?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onBlur);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [menu, close]);

  if (!menu) return null;

  const restoreFocus = () => {
    const target = menu.returnFocus;
    close();
    if (target?.isConnected) target.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      restoreFocus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      if (buttons.length === 0) return;
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const forward = e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey);
      const next = forward
        ? (index + 1) % buttons.length
        : (index - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[200px] max-w-[320px] rounded-lg border border-border bg-elevated p-1 shadow-pop"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {menu.items.map((item, i) =>
        "separator" in item ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list for one menu instance
          <hr key={`sep-${i}`} className="my-1 border-border" />
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat
            key={`${item.label}-${i}`}
            type="button"
            {...(item.checked === undefined
              ? { role: "menuitem" }
              : { role: "menuitemcheckbox", "aria-checked": item.checked })}
            disabled={item.disabled}
            onClick={() => {
              restoreFocus();
              item.onSelect();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px] text-text outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-45 disabled:hover:bg-transparent"
          >
            <span className="flex w-4 shrink-0 items-center justify-center text-text-2">
              {item.checked ? <Check size={14} aria-hidden /> : item.icon}
            </span>
            {item.description ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                <span className="text-[12px] leading-snug text-balance text-text-3">
                  {item.description}
                </span>
              </span>
            ) : (
              <span className="flex-1 truncate">{item.label}</span>
            )}
            {item.hint && (
              <span className="text-[12px] text-text-3">{item.hint}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
