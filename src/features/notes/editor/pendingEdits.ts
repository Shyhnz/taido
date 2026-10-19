/**
 * Page text not yet in the core: the editors' pending saves, sent before an action that
 * reads or removes the page (delete, duplicate, move), and drafts too long to be saved
 *, kept on this device so leaving the page loses nothing.
 */

const flushers = new Set<() => Promise<void>>();

/** Registers an editor's « send now »; returns the unregistering function. */
export function registerNoteFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

const inFlight = new Set<Promise<unknown>>();

/** Keeps track of a save under way, so `flushNoteEdits` waits for it too. */
export function trackNoteSave(save: Promise<unknown>): void {
  inFlight.add(save);
  void save.finally(() => inFlight.delete(save));
}

/** Sends every pending page edit and waits until the core has them. */
export async function flushNoteEdits(): Promise<void> {
  await Promise.all(Array.from(flushers, (f) => f()));
  await Promise.allSettled(Array.from(inFlight));
}

const DRAFT_KEY = (pageId: string) => `todo.noteDraft.${pageId}`;

/** Text too long to save, and the stored body it was written over (to spot a newer one). */
export interface NoteDraft {
  markdown: string;
  base: string;
}

const drafts = new Map<string, NoteDraft>();

function readStored(pageId: string): NoteDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY(pageId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as NoteDraft).markdown === "string" &&
      typeof (parsed as NoteDraft).base === "string"
    ) {
      return parsed as NoteDraft;
    }
    return null;
  } catch {
    return null;
  }
}

/** A page's text kept because it was too long to save, if any. */
export function noteDraft(pageId: string): NoteDraft | null {
  return drafts.get(pageId) ?? readStored(pageId);
}

export function keepNoteDraft(pageId: string, draft: NoteDraft): void {
  drafts.set(pageId, draft);
  try {
    window.localStorage.setItem(DRAFT_KEY(pageId), JSON.stringify(draft));
  } catch {
    // Kept in memory only (private window, storage full).
  }
}

export function dropNoteDraft(pageId: string): void {
  drafts.delete(pageId);
  try {
    window.localStorage.removeItem(DRAFT_KEY(pageId));
  } catch {
    // Nothing stored.
  }
}

/** Tests: the mock backend gives the same ids again after a reset. */
export function forgetNoteDrafts(): void {
  for (const id of Array.from(drafts.keys())) dropNoteDraft(id);
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("todo.noteDraft."))
        window.localStorage.removeItem(key);
    }
  } catch {
    // No storage.
  }
}

const mounted = new Map<string, number>();

/** Counts the editors showing a page (React may mount one twice in a row). */
export function editorMounted(pageId: string): () => void {
  mounted.set(pageId, (mounted.get(pageId) ?? 0) + 1);
  return () => {
    const n = (mounted.get(pageId) ?? 1) - 1;
    if (n <= 0) mounted.delete(pageId);
    else mounted.set(pageId, n);
  };
}

export function isEditorMounted(pageId: string): boolean {
  return (mounted.get(pageId) ?? 0) > 0;
}
