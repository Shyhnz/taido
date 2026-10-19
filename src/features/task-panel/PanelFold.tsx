/**
 * Folded sections of the task panel, layout C (2026-10-11, mock-ups in the chat):
 * every section below the terminals is one row « › Titre ……… résumé », so the panel shows
 * everything at a glance without opening anything. Which sections are open is remembered for
 * all tasks in `localStorage` (like the sidebar folds); storage may be unavailable, so every
 * access is guarded.
 */

import { ChevronRight } from "lucide-react";
import { type ClipboardEvent, type ReactNode, useId } from "react";
import { create } from "zustand";

export type FoldKey =
  | "subtasks"
  | "attachments"
  | "relations"
  | "chrono"
  | "sessions"
  | "technical"
  | "journal"
  | "mentions";

export const PANEL_FOLDS_KEY = "todo.panelFolds";

type Stored = Partial<Record<FoldKey, boolean>>;

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(PANEL_FOLDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

interface FoldState {
  /** Choices made by the user; a section never toggled follows its default. */
  stored: Stored;
  /** Sections opened from « Ajouter : … » or « Bloquée par » for the current task only. */
  forced: Partial<Record<FoldKey, boolean>>;
  setOpen: (key: FoldKey, open: boolean) => void;
  force: (key: FoldKey) => void;
  resetForced: () => void;
}

export const usePanelFolds = create<FoldState>((set, get) => ({
  stored: load(),
  forced: {},
  setOpen: (key, open) => {
    const stored = { ...get().stored, [key]: open };
    const forced = { ...get().forced };
    delete forced[key];
    set({ stored, forced });
    try {
      window.localStorage.setItem(PANEL_FOLDS_KEY, JSON.stringify(stored));
    } catch {
      // Not remembered: the panel still works.
    }
  },
  force: (key) => set({ forced: { ...get().forced, [key]: true } }),
  resetForced: () => set({ forced: {} }),
}));

/** Open state of a section: forced, else the user's choice, else `fallback`. */
export function useFoldOpen(key: FoldKey, fallback: boolean): boolean {
  return usePanelFolds((s) => s.forced[key] ?? s.stored[key] ?? fallback);
}

/** Opens a section for the current task and brings it into view. */
export function revealFold(key: FoldKey): void {
  usePanelFolds.getState().force(key);
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-fold="${key}"]`)
      ?.scrollIntoView?.({ block: "nearest" }),
  );
}

export function Fold({
  id,
  title,
  summary,
  defaultOpen = false,
  attachTask,
  onPaste,
  children,
}: {
  id: FoldKey;
  title: string;
  /** What the section holds, shown at the end of the row (open or closed). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Files dropped on the section, folded or not, become this task's attachments. */
  attachTask?: string;
  onPaste?: (e: ClipboardEvent) => void;
  children: ReactNode;
}) {
  const open = useFoldOpen(id, defaultOpen);
  const setOpen = usePanelFolds((s) => s.setOpen);
  const contentId = useId();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-fold={id}
      data-attach-task={attachTask}
      onPaste={onPaste}
      className="border-t border-border"
    >
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          onClick={() => setOpen(id, !open)}
          className="flex min-h-10 w-full min-w-0 items-center gap-2 py-2 text-left hover:text-text"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`shrink-0 text-text-3 ${open ? "rotate-90" : ""}`}
          />
          <span
            id={titleId}
            className="shrink-0 text-[13.5px] font-medium text-text"
          >
            {title}
          </span>
          {summary != null && summary !== false && (
            <span className="ml-auto flex min-w-0 items-center justify-end gap-2 truncate text-[12.5px] font-normal text-text-2 tabular-nums">
              {summary}
            </span>
          )}
        </button>
      </h2>
      {open && (
        <div id={contentId} className="pb-4 pl-[22px]">
          {children}
        </div>
      )}
    </section>
  );
}

/** Thin progress bar of the subtasks summary. */
export function FoldProgress({ done, total }: { done: number; total: number }) {
  return (
    <span
      aria-hidden
      className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-border"
    >
      <span
        className="block h-full rounded-full bg-done"
        style={{ width: `${total ? (done / total) * 100 : 0}%` }}
      />
    </span>
  );
}
