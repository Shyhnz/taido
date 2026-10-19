/**
 * Images cut or copied from a page (plan task 8, fix round 1). Cutting an image from page A
 * and pasting it in page B closes A first: A's cleanup must not delete the file the clipboard
 * still holds. Those images are only offered to the core's cleanup (`pruneNoteImages`, which
 * keeps whatever a live page shows) once the clipboard holds something else; a paste in
 * another page meanwhile copies the file there (`copyNoteAttachment`).
 */

import { commands, errorMessage } from "../../../lib/ipc";
import { flushNoteEdits } from "./pendingEdits";

/** The image ids of the last cut or copy made in a page. */
let held = new Set<string>();
/** Images taken out of a page while the clipboard held them: page id → ids. */
const deferred = new Map<string, Set<string>>();

/** What the open editors show now, saved or not. */
const shownBy = new Set<() => Iterable<string>>();

/** An open editor tells what images it shows; returns the cleanup. */
export function registerShownImages(read: () => Iterable<string>): () => void {
  shownBy.add(read);
  return () => {
    shownBy.delete(read);
  };
}

/**
 * Offers images to the core's cleanup, which keeps whatever a stored page shows. A page being
 * written may show one it has not saved yet (a paste within the 600 ms before its save): the
 * pending edits are sent first, and what an open editor shows is never offered. Failures are
 * only logged (nothing is lost).
 */
export function pruneImages(pageId: string, ids: string[]): void {
  if (ids.length === 0) return;
  void (async () => {
    try {
      await flushNoteEdits();
      const shown = new Set<string>();
      for (const read of shownBy) for (const id of read()) shown.add(id);
      const left = ids.filter((id) => !shown.has(id));
      if (left.length === 0) return;
      await commands.pruneNoteImages({ pageId, candidateIds: left });
    } catch (error) {
      console.error(errorMessage(error), error);
    }
  })();
}

/** A cut or copy in a page: what the clipboard holds now. */
export function noteClipboard(ids: Iterable<string>): void {
  held = new Set(ids);
  for (const [pageId, waiting] of deferred) {
    const free = [...waiting].filter((id) => !held.has(id));
    if (free.length === 0) continue;
    for (const id of free) waiting.delete(id);
    if (waiting.size === 0) deferred.delete(pageId);
    pruneImages(pageId, free);
  }
}

/**
 * The images taken out of `pageId`, at its close: cleaned up now, except those the clipboard
 * holds (cleaned up once it holds something else).
 */
export function pruneOrDefer(pageId: string, ids: string[]): void {
  const now = ids.filter((id) => !held.has(id));
  const later = ids.filter((id) => held.has(id));
  if (later.length > 0) {
    const waiting = deferred.get(pageId) ?? new Set<string>();
    for (const id of later) waiting.add(id);
    deferred.set(pageId, waiting);
  }
  pruneImages(pageId, now);
}

/** Tests: the mock gives the same ids again after a reset. */
export function forgetImageClipboard(): void {
  held = new Set();
  deferred.clear();
  shownBy.clear();
}
