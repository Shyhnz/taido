/**
 * The sidebar's top level: the top-level projects with « Sans projet » at its stored place
 * among them (synced setting `inbox_position`, read through `get_inbox_index`).
 */

import type { Subject } from "../../bindings";

export type TopLevelItem =
  | { kind: "subject"; subject: Subject }
  | { kind: "inbox" };

/** Top-level projects with « Sans projet » inserted at `inboxIndex` (clamped). */
export function topLevelItems(
  top: Subject[],
  inboxIndex: number,
): TopLevelItem[] {
  const at = Math.max(0, Math.min(Math.trunc(inboxIndex), top.length));
  const items: TopLevelItem[] = top.map((subject) => ({
    kind: "subject",
    subject,
  }));
  items.splice(at, 0, { kind: "inbox" });
  return items;
}

/**
 * Index of the project at `i` of `top` in the top-level order, where « Sans projet » counts
 * even when the sidebar hides it (`reorder_subject` takes this index).
 */
export function topLevelIndex(i: number, inboxIndex: number): number {
  return i < inboxIndex ? i : i + 1;
}
