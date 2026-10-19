/**
 * Global polite aria-live region (audit A7, A8). Any feature calls `announce("Tâche ajoutée
 * dans Globex")` to have a screen reader read a short status without moving the focus.
 * Toasts are already announced by their own host (src/components/Toast.tsx): don't announce
 * them twice.
 */

import { create } from "zustand";

interface Announcement {
  message: string;
  /** Changes on every call, so the same text is read again. */
  nonce: number;
}

export const useAnnouncer = create<Announcement>(() => ({
  message: "",
  nonce: 0,
}));

/** Reads `message` politely (after what the screen reader is saying). */
export function announce(message: string): void {
  useAnnouncer.setState((s) => ({ message, nonce: s.nonce + 1 }));
}

export function LiveRegion() {
  const { message, nonce } = useAnnouncer();
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {/* A new node on every call: screen readers announce additions reliably. */}
      {message && <span key={nonce}>{message}</span>}
    </div>
  );
}
