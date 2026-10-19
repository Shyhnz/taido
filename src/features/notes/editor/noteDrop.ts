/**
 * Files dropped from the Finder on an open page (plan task 8). On the Mac, Tauri takes native
 * drops (`fileDrop.ts`) and gives paths and a position, not an HTML drop event: the page's
 * editor registers here, and a drop over its text (`[data-note-drop]`) goes to it rather than
 * to a task or a terminal.
 */

export type NoteDropHandler = (paths: string[], x: number, y: number) => void;

const handlers = new Map<string, NoteDropHandler>();

/** The open editor of `pageId` takes drops; returns the cleanup. */
export function registerNoteDrop(
  pageId: string,
  handler: NoteDropHandler,
): () => void {
  handlers.set(pageId, handler);
  return () => {
    if (handlers.get(pageId) === handler) handlers.delete(pageId);
  };
}

/** The open page under the point, and what takes the files dropped there. */
export function noteDropAt(
  x: number,
  y: number,
): { el: HTMLElement; drop: (paths: string[]) => void } | null {
  const hit = document.elementFromPoint?.(x, y);
  const el = hit?.closest<HTMLElement>("[data-note-drop]");
  const pageId = el?.dataset.noteDrop;
  const handler = pageId ? handlers.get(pageId) : undefined;
  if (!el || !handler) return null;
  return { el, drop: (paths) => handler(paths, x, y) };
}
