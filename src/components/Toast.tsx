/**
 * Toasts at the bottom of the window ("Tâche terminée · Annuler" stays 5 s).
 * Error toasts stay until closed (audit B3). Both kinds sit in live regions that are always
 * mounted, so screen readers announce them: polite for information, assertive for errors.
 */

import { X } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { t } from "../i18n";

export const TOAST_DURATION_MS = 5000;

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; onAction: () => void };
  tone?: "default" | "error";
  /**
   * Auto-dismiss delay in ms. Default: `TOAST_DURATION_MS` for information, `null` (stays
   * until closed) for errors.
   */
  duration?: number | null;
}

interface ToastState {
  toasts: Toast[];
  show: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = nextId++;
    // One toast at a time, like Todoist.
    set({ toasts: [{ ...toast, id }] });
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const showToast = (toast: Omit<Toast, "id">) =>
  useToasts.getState().show(toast);

/**
 * `message` is already readable French (see `readableError` in src/lib/run.ts). Stays until
 * closed.
 */
export const showError = (message: string) =>
  showToast({ message, tone: "error" });

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const duration =
    toast.duration !== undefined
      ? toast.duration
      : toast.tone === "error"
        ? null
        : TOAST_DURATION_MS;
  useEffect(() => {
    if (duration === null) return;
    const timer = setTimeout(() => dismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast.id, duration, dismiss]);

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-text py-2 pr-2 pl-4 text-[13.5px] text-bg shadow-pop">
      <span className={toast.tone === "error" ? "font-medium" : ""}>
        {toast.message}
      </span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onAction();
            dismiss(toast.id);
          }}
          className="rounded-md px-2 py-1 font-semibold underline-offset-2 hover:underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={t.common.close}
        onClick={() => dismiss(toast.id)}
        className="rounded-md p-1 opacity-70 hover:opacity-100"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const info = toasts.filter((t) => t.tone !== "error");
  const errors = toasts.filter((t) => t.tone === "error");
  return (
    <section
      aria-label={t.app.notifications}
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {/* Always mounted: a live region must exist before its content changes. */}
      <div role="status" className="flex flex-col items-center gap-2">
        {info.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
      <div role="alert" className="flex flex-col items-center gap-2">
        {errors.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </section>
  );
}
