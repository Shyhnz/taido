/**
 * Reads of the project notebook and the layout switch:
 * two panes from 768 px (and always on the Mac), the list then a full-screen page below.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  NotebookView,
  NoteGroup,
  NoteKind,
  NotePage,
  NotePageRow,
  NoteTarget,
} from "../../bindings";
import { t } from "../../i18n";
import { commands } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { useMediaQuery } from "../../lib/screen";
import { IS_MOBILE } from "../../lib/target";

/** Width from which the notebook shows its list and a page side by side. */
export const NOTES_WIDE_QUERY = "(min-width: 768px)";

/** True on the Mac, and on the web from 768 px wide. */
export function useNotesWide(): boolean {
  const wide = useMediaQuery(NOTES_WIDE_QUERY);
  return !IS_MOBILE || wide;
}

/** `useNotesWide` outside React (⌘K, the floating « + »). */
export function notesWideNow(): boolean {
  if (!IS_MOBILE) return true;
  return window.matchMedia?.(NOTES_WIDE_QUERY).matches ?? false;
}

/** A page's query; under `notebooks`, so the `notes` scope refreshes it. */
export const notePageKey = (id: string) => ["notebook", "page", id] as const;

export const useNotebook = (subjectId: string) =>
  useQuery({
    queryKey: queryKeys.notebook(subjectId),
    queryFn: () => commands.notebook(subjectId),
  });

export const useNotePage = (id: string, enabled = true) =>
  useQuery({
    queryKey: notePageKey(id),
    queryFn: () => commands.getNotePage(id),
    retry: false,
    enabled,
  });

/** Pages and tasks that link a page (« Mentionné dans »); under `notebooks` too. */
export const useNoteBacklinks = (pageId: string) =>
  useQuery({
    queryKey: ["notebook", "backlinks", pageId] as const,
    queryFn: () => commands.notePageBacklinks(pageId),
  });

/** Pages that link a task (task panel « Mentionné dans les notes »); under `notebooks`. */
export const useTaskNoteMentions = (taskId: string) =>
  useQuery({
    queryKey: ["notebook", "mentions", taskId] as const,
    queryFn: () => commands.taskNoteMentions(taskId),
  });

/** Where a page sits in the list: its block. */
export type NotePlace = NoteTarget;

/** One block of the list, in display order. */
export interface NoteBlock {
  /** `pinned`, `ungrouped`, `summaries` or a group. */
  place: NotePlace;
  group: NoteGroup | null;
  pages: NotePageRow[];
}

/** The notebook's blocks in display order: Épinglées, outside any group, groups, Résumés. */
export function noteBlocks(nb: NotebookView): NoteBlock[] {
  return [
    { place: "pinned", group: null, pages: nb.pinned },
    { place: "ungrouped", group: null, pages: nb.ungrouped },
    ...nb.groups.map(
      (g): NoteBlock => ({
        place: { group: { id: g.group.id } },
        group: g.group,
        pages: g.pages,
      }),
    ),
    { place: "summaries", group: null, pages: nb.summaries },
  ];
}

/** Every page of the notebook, in display order. */
export function notePages(nb: NotebookView): NotePageRow[] {
  return noteBlocks(nb).flatMap((b) => b.pages);
}

/** The place of a page as the list shows it (the core keeps a pinned page's group). */
export function placeOf(page: NotePage): NotePlace {
  if (page.pinnedAt !== null) return "pinned";
  if (page.groupId !== null) return { group: { id: page.groupId } };
  return page.kind === "summary" ? "summaries" : "ungrouped";
}

export function samePlace(a: NotePlace, b: NotePlace): boolean {
  if (typeof a === "object" && typeof b === "object") {
    return a.group.id === b.group.id;
  }
  return a === b;
}

/**
 * The notebook's search field: the core's search restricted to the project (whole pages, every
 * hit). `hits`: the ids of the matching pages, `undefined` until the first answer; `failed`
 * when the search call failed (`retry` asks again).
 */
export function useNoteSearch(
  subjectId: string,
  query: string,
): {
  hits: ReadonlySet<string> | undefined;
  failed: boolean;
  retry: () => void;
} {
  const q = query.trim();
  const search = useQuery({
    queryKey: queryKeys.searchNotes(q, subjectId),
    queryFn: () => commands.searchNotes(q, subjectId),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
  const retry = () => {
    void search.refetch();
  };
  if (q.length === 0) return { hits: undefined, failed: false, retry };
  return {
    hits:
      search.data === undefined
        ? undefined
        : new Set(search.data.map((h) => h.id)),
    failed: search.isError,
    retry,
  };
}

/**
 * The blocks keeping only the pages in `hits` (the core's search, see `useNoteSearch`); with
 * no hits yet, nothing is filtered out but by an empty query.
 */
export function filterBlocks(
  blocks: NoteBlock[],
  hits: ReadonlySet<string> | undefined,
): NoteBlock[] {
  if (hits === undefined) return blocks;
  return blocks.map((b) => ({
    ...b,
    pages: b.pages.filter((p) => hits.has(p.id)),
  }));
}

/** Where a page of `kind` at `place` can be moved: outside any group, then each group. */
export function moveTargets(
  kind: NoteKind,
  place: NotePlace,
  groups: NoteGroup[],
): { target: NoteTarget; label: string }[] {
  const loose: NoteTarget = kind === "summary" ? "summaries" : "ungrouped";
  const all = [
    {
      target: loose,
      label: kind === "summary" ? t.notes.summaries : t.notes.ungrouped,
    },
    ...groups.map((g) => ({
      target: { group: { id: g.id } } as NoteTarget,
      label: g.name,
    })),
  ];
  return all.filter((t) => !samePlace(place, t.target));
}
