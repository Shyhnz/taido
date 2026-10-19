/**
 * ⌘K « Aller à une tâche »: a command palette. The field filters the
 * tasks by title or project through `search_tasks` (debounced); ↑ ↓ choose, Entrée opens the
 * task in its project (or « Sans projet »), selected, with its panel open; Échap closes.
 *
 * Each hit shows the task's ring, its title and « Projet › Section »; completed tasks are
 * dimmed (the core lists them after the open ones). The pages of the project notebooks
 * (`search_notes`) follow the tasks, with a note icon and « Note · Projet ».
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, StickyNote } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { NoteHit, TaskHit } from "../../bindings";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { useUi } from "../../stores/ui";
import { notesWideNow } from "../notes/queries";
import { PriorityRing } from "../task-row/PriorityRing";
import { StateDot } from "../task-row/StateDot";

/** Wait after the last keystroke before asking the core. */
export const SEARCH_DEBOUNCE_MS = 120;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Opens a task found by ⌘K: its project view (or « Sans projet »), the row selected and its
 * panel open, the row scrolled into view once the list shows it.
 */
export function goToTask(hit: Pick<TaskHit, "id" | "subject">): void {
  const ui = useUi.getState();
  ui.closeDialog();
  ui.setView(
    hit.subject
      ? { kind: "subject", subjectId: hit.subject.id }
      : { kind: "inbox", subjectId: null },
  );
  ui.openTask(hit.id);
  setTimeout(() => {
    const row = document.querySelector(
      `[data-task-id="${CSS.escape(hit.id)}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, 50);
}

/** What ⌘K lists: a task, or a page of a project's notebook. */
type Hit = { kind: "task"; hit: TaskHit } | { kind: "note"; hit: NoteHit };

/**
 * Opens a notebook page found by ⌘K: its project on the « Notes » tab, that page selected
 * (on a phone, in its full-screen sheet).
 */
export function goToNote(hit: Pick<NoteHit, "id" | "subject">): void {
  const ui = useUi.getState();
  ui.closeDialog();
  ui.setView({ kind: "subject", subjectId: hit.subject.id });
  ui.setProjectTab("notes");
  ui.openNotePage(hit.subject.id, hit.id, !notesWideNow());
}

function open(hit: Hit): void {
  if (hit.kind === "task") goToTask(hit.hit);
  else goToNote(hit.hit);
}

function NoteRow({
  hit,
  id,
  active,
  onPoint,
  onOpen,
}: {
  hit: NoteHit;
  id: string;
  active: boolean;
  onPoint: () => void;
  onOpen: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field drives the keyboard (aria-activedescendant)
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-note-id={hit.id}
      onMouseMove={onPoint}
      onClick={onOpen}
      className={`flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 ${
        active ? "bg-selected" : ""
      }`}
    >
      <StickyNote
        size={15}
        aria-hidden="true"
        className="shrink-0 text-text-3"
      />
      <span className="min-w-0 flex-1 truncate text-[14px] text-text">
        {hit.title}
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-[12.5px] text-text-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: subjectColorVar(hit.subject.color) }}
        />
        <span className="truncate">{t.search.noteWhere(hit.subject.name)}</span>
      </span>
    </div>
  );
}

function HitRow({
  hit,
  id,
  active,
  onPoint,
  onOpen,
}: {
  hit: TaskHit;
  id: string;
  active: boolean;
  onPoint: () => void;
  onOpen: () => void;
}) {
  const agent = useDefaultAgent();
  const where = hit.subject
    ? t.search.where(hit.subject.name, hit.section?.name ?? null)
    : t.search.noProject;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field drives the keyboard (aria-activedescendant)
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-completed={hit.completed || undefined}
      onMouseMove={onPoint}
      onClick={onOpen}
      className={`flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 ${
        active ? "bg-selected" : ""
      }`}
    >
      {/* The plain checkbox (hits carry no priority), Claude's dot after
          the title like in the lists. */}
      <span className={hit.completed ? "opacity-60" : ""}>
        <PriorityRing priority={1} completed={hit.completed} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className={`min-w-0 truncate text-[14px] ${
            hit.completed ? "text-text-3" : "text-text"
          }`}
        >
          {hit.title}
          {hit.completed && (
            <span className="sr-only">, {t.search.completed}</span>
          )}
        </span>
        {features.states && (
          <StateDot ring={hit.ring} agent={agent} size={10} />
        )}
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-[12.5px] text-text-2">
        {hit.subject && (
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: subjectColorVar(hit.subject.color) }}
          />
        )}
        <span className="truncate">{where}</span>
      </span>
    </div>
  );
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  /** Entrée pressed while the hits shown were for an older text: opens the first fresh hit. */
  const [enterPending, setEnterPending] = useState(false);
  const query = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  const listRef = useRef<HTMLDivElement>(null);

  const search = useQuery({
    queryKey: queryKeys.search(query),
    queryFn: () => commands.searchTasks(query),
    enabled: query.length > 0,
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
  });
  // The notebook pages come after the tasks. They are a bonus: a failure (the web app has no
  // notebook search yet) shows no page, never an error.
  const pages = useQuery({
    queryKey: queryKeys.searchNotes(query),
    queryFn: () => commands.searchNotes(query, null).catch((): NoteHit[] => []),
    enabled: query.length > 0,
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
  });
  const shown = query.length > 0 && text.trim().length > 0;
  const hits: Hit[] = shown
    ? [
        ...(search.data ?? []).map((hit): Hit => ({ kind: "task", hit })),
        ...(pages.data ?? []).map((hit): Hit => ({ kind: "note", hit })),
      ]
    : [];
  /** The hits shown answer the text as typed (not the previous query's, kept while typing). */
  const fresh =
    query === text.trim() &&
    search.data !== undefined &&
    pages.data !== undefined &&
    !search.isPlaceholderData &&
    !pages.isPlaceholderData &&
    !search.isError;

  // A new list starts on its first hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the results change
  useEffect(() => setActive(0), [search.data, pages.data]);

  useEffect(() => {
    if (!enterPending) return;
    if (search.isError) setEnterPending(false);
    if (!fresh) return;
    setEnterPending(false);
    const first = hits[0];
    if (first) open(first);
  }, [enterPending, fresh, hits, search.isError]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView?.({ block: "nearest" });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + delta + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (text.trim().length === 0) return;
      // The hits on screen may still be the previous query's: wait for this text's own.
      if (!fresh) {
        setEnterPending(true);
        return;
      }
      const hit = hits[active];
      if (hit) open(hit);
    }
  };

  let body: ReactNode;
  if (text.trim().length === 0) {
    body = <Note>{t.search.hint}</Note>;
  } else if (search.isError) {
    body = (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 px-2.5 py-3"
      >
        <p className="text-[13px] text-text">{t.search.error}</p>
        <Button size="sm" onClick={() => void search.refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  } else if (
    search.data === undefined ||
    pages.data === undefined ||
    query !== text.trim()
  ) {
    // Typing, or the first answer is on its way: the previous hits stay shown meanwhile.
    body = hits.length > 0 ? null : <Note status>{t.search.loading}</Note>;
  } else if (hits.length === 0) {
    body = <Note status>{t.search.none(query)}</Note>;
  }

  const showList = hits.length > 0 && !search.isError;

  return (
    <Dialog title={t.search.title} onClose={onClose} width={600} hideTitle>
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Search size={17} aria-hidden className="shrink-0 text-text-3" />
        <input
          role="combobox"
          aria-label={t.search.label}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(active) : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setEnterPending(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={t.search.placeholder}
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-text-3"
          data-autofocus
        />
      </div>
      <div className="max-h-[min(400px,calc(100vh-300px))] overflow-y-auto p-1.5">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t.search.results}
          hidden={!showList}
        >
          {showList &&
            hits.map((h, i) =>
              h.kind === "task" ? (
                <HitRow
                  key={`task-${h.hit.id}`}
                  hit={h.hit}
                  id={optionId(i)}
                  active={i === active}
                  onPoint={() => setActive(i)}
                  onOpen={() => open(h)}
                />
              ) : (
                <NoteRow
                  key={`note-${h.hit.id}`}
                  hit={h.hit}
                  id={optionId(i)}
                  active={i === active}
                  onPoint={() => setActive(i)}
                  onOpen={() => open(h)}
                />
              ),
            )}
        </div>
        {body}
      </div>
      <p className="border-t border-border px-4 py-2 text-[12px] text-text-3">
        {t.search.footer}
      </p>
    </Dialog>
  );
}

function Note({
  children,
  status = false,
}: {
  children: ReactNode;
  status?: boolean;
}) {
  return (
    <p
      role={status ? "status" : undefined}
      className="px-2.5 py-5 text-center text-[13px] text-text-2"
    >
      {children}
    </p>
  );
}
