/**
 * The notebook's list of pages: the search field,
 * « Épinglées », the pages outside any group (no header, like « Sans section »), the groups,
 * « Résumés de tâches », then « + Nouvelle page » (large screen) and « + Nouveau groupe ».
 * Large screen: compact rows, the open page highlighted, « … » on hover. Phone: rows of 48 px
 * with the start of the text.
 *
 * Pages move by drag and drop (task 6) in the window's DndContext: the mouse drags a row
 * (5 px), a finger after a long press (300 ms; held still then released, it opens the page's
 * menu instead); ⌥↑ / ⌥↓ move the focused page within its block. « Épinglées » always shows,
 * even empty, so it can take a page; nothing appears during a drag (no layout shift).
 */

import { type DragEndEvent, useDndMonitor, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Ellipsis, Pin, Plus, Search, X } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  NotebookView,
  NoteGroup,
  NotePageRow,
  NoteTarget,
} from "../../bindings";
import {
  openContextMenu,
  openMenuAt,
  useMenuStore,
} from "../../components/Menu";
import { fr } from "../../i18n/fr";
import { formatShortDate } from "../../lib/dates";
import { features } from "../../lib/features";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { noteFoldKey, useUi } from "../../stores/ui";
import {
  type DragData,
  dragId,
  heldStill,
  notePageAccepts,
} from "../dnd/DndProvider";
import { isTouchContextMenu } from "../dnd/sensors";
import { InlineNameInput } from "../sidebar/Sidebar";
import { NoteGroupHeader } from "./NoteGroupHeader";
import {
  createNoteGroup,
  createNotePage,
  type PageRef,
  pageMenuItems,
  promptNewGroup,
  useGroupRename,
} from "./noteActions";
import {
  filterBlocks,
  type NoteBlock,
  noteBlocks,
  samePlace,
  useNoteSearch,
} from "./queries";

function blockName(block: NoteBlock): string {
  if (block.group) return block.group.name;
  if (block.place === "pinned") return fr.notes.pinned;
  if (block.place === "summaries") return fr.notes.summaries;
  return fr.notes.ungrouped;
}

/** A stable key for a block's place. */
function placeKey(place: NoteTarget): string {
  return typeof place === "object" ? `group:${place.group.id}` : place;
}

function foldKeyOf(subjectId: string, block: NoteBlock): string | null {
  if (block.group) return noteFoldKey(subjectId, { group: block.group.id });
  if (block.place === "pinned" || block.place === "summaries") {
    return noteFoldKey(subjectId, block.place);
  }
  return null;
}

function SummaryBadge() {
  return (
    <span className="shrink-0 rounded px-1 py-px text-[10px] font-semibold tracking-[0.04em] text-text-3 uppercase ring-1 ring-border">
      {fr.notes.summaryBadge}
    </span>
  );
}

type PageDrag = Extract<DragData, { type: "note_page" }>;

/** Drags are on (mouse on the Mac and the web, fingers on the web app). */
const canDrag = () => features.dragAndDrop || features.touchDrag;

/** The page moved with ⌥↑ / ⌥↓: its row takes the focus back once it has moved. */
let focusAfterMove: string | null = null;

/** ⌥↑ / ⌥↓: one slot up or down within its block (« Épinglées » is not reordered). */
async function movePageBy(drag: PageDrag, step: -1 | 1) {
  if (drag.place === "pinned") return;
  const index = drag.blockPages.indexOf(drag.pageId) + step;
  if (index < 0 || index >= drag.blockPages.length) return;
  focusAfterMove = drag.pageId;
  const moved = await run(
    commands.moveNotePage({ id: drag.pageId, target: drag.place, index }),
    fr.notes.errors.movePage,
  );
  if (!moved && focusAfterMove === drag.pageId) focusAfterMove = null;
}

/** Where a touch drag held still started, or `null` (a mouse, or the page moved). */
function touchHeldStillAt(
  event: DragEndEvent,
): { x: number; y: number } | null {
  const start = event.activatorEvent;
  if (typeof TouchEvent === "undefined" || !(start instanceof TouchEvent)) {
    return null;
  }
  if (!heldStill(event)) return null;
  const point = start.touches[0] ?? start.changedTouches[0];
  return point ? { x: point.clientX, y: point.clientY } : null;
}

function PageRow({
  subjectId,
  row,
  block,
  blockPages,
  groups,
  selected,
  wide,
  searching,
  onOpen,
}: {
  subjectId: string;
  row: NotePageRow;
  block: NoteBlock;
  /** Ids of the block's pages in display order (the search may hide some). */
  blockPages: readonly string[];
  groups: NoteGroup[];
  selected: boolean;
  wide: boolean;
  /** A search filters the list: ⌥↑ / ⌥↓ would move past hidden pages, so they are off. */
  searching: boolean;
  onOpen: () => void;
}) {
  const drag: PageDrag = {
    type: "note_page",
    pageId: row.id,
    title: row.title,
    kind: row.kind,
    subjectId,
    place: block.place,
    blockPages,
  };
  const id = dragId.notePage(row.id);
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id, data: drag, disabled: !canDrag() });
  // Pointer and long press only: dnd-kit's keyboard drag would take Enter and Space from the
  // row's button; ⌥↑ / ⌥↓ move the page instead.
  const { onKeyDown: _keyboardDrag, ...dragListeners } = listeners ?? {};
  const focusRef = useRef<HTMLButtonElement>(null);
  const index = blockPages.indexOf(row.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` changes when the moved row lands at its new place
  useEffect(() => {
    if (focusAfterMove !== row.id) return;
    focusAfterMove = null;
    focusRef.current?.focus();
  }, [index, row.id]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (searching) return;
    void movePageBy(drag, e.key === "ArrowUp" ? -1 : 1);
  };
  const ref: PageRef = {
    id: row.id,
    title: row.title,
    kind: row.kind,
    place: block.place,
  };
  const label = fr.notes.pageMenu(row.title);
  const menuAt = (x: number, y: number) =>
    pageMenuItems(subjectId, ref, groups, { x, y });
  // A finger held still on the row, then lifted: the page's menu (§ 4.2).
  useDndMonitor({
    onDragEnd: (event) => {
      if (event.active.id !== id) return;
      const at = touchHeldStillAt(event);
      if (at) {
        useMenuStore.getState().open(at.x, at.y, menuAt(at.x, at.y), label);
      }
    },
  });
  // The long press picks the page up: the browser's menu under the finger is not the page's.
  const onContextMenu = (e: ReactMouseEvent) => {
    if (isTouchContextMenu(e)) e.preventDefault();
    else openContextMenu(e, menuAt(e.clientX, e.clientY), label);
  };
  const style = { transform: CSS.Translate.toString(transform), transition };
  const dragClass = isDragging ? "relative z-10 opacity-40" : "";
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      {block.place === "pinned" && (
        <Pin size={12} aria-hidden className="shrink-0 text-text-3" />
      )}
      <span data-note-title className="min-w-0 truncate">
        {row.title}
      </span>
      {row.kind === "summary" && <SummaryBadge />}
    </span>
  );

  if (!wide) {
    const second =
      row.kind === "summary"
        ? fr.notes.summaryLine(formatShortDate(new Date(row.updatedAt)))
        : row.excerpt;
    return (
      <button
        type="button"
        ref={(el) => {
          setNodeRef(el);
          focusRef.current = el;
        }}
        style={style}
        {...dragListeners}
        data-note-page
        data-note-row={row.id}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        className={`touch-drag flex min-h-12 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left active:bg-hover ${dragClass}`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[16px] leading-6">{title}</span>
          {second && (
            <span className="truncate text-[13.5px] leading-5 text-text-3">
              {second}
            </span>
          )}
        </span>
        <ChevronRight size={18} aria-hidden className="shrink-0 text-text-3" />
      </button>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click mirrors the « … » button
    <div
      ref={setNodeRef}
      style={style}
      {...dragListeners}
      data-note-page
      onContextMenu={onContextMenu}
      className={`touch-drag group/row flex h-8 items-center rounded-md pr-0.5 ${
        selected ? "bg-nav-active" : "hover:bg-hover"
      } ${dragClass}`}
    >
      <button
        type="button"
        ref={focusRef}
        data-note-row={row.id}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        className="flex h-full min-w-0 flex-1 items-center rounded-md pl-2 text-left text-[13.5px]"
      >
        {title}
      </button>
      <button
        type="button"
        aria-label={label}
        title={fr.common.more}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          openMenuAt(
            e.currentTarget,
            menuAt(rect.right, rect.bottom + 4),
            label,
            true,
          );
        }}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text focus-visible:opacity-100 ${
          // Hidden until hovered only where there is a hover (a touch screen always shows it).
          selected
            ? "opacity-100"
            : "[@media(hover:hover)]:opacity-0 group-hover/row:opacity-100"
        }`}
      >
        <Ellipsis size={15} aria-hidden />
      </button>
    </div>
  );
}

/**
 * A block of the list (« Épinglées », outside any group, a group, « Résumés de tâches »): it
 * receives a page dropped on its header or margins (at its end; « Épinglées » pins it) and
 * lights up while a page from elsewhere is held over it.
 */
function Block({
  subjectId,
  block,
  name,
  children,
}: {
  subjectId: string;
  block: NoteBlock;
  name: string;
  children: ReactNode;
}) {
  const data: DragData = {
    type: "note_group_drop",
    subjectId,
    place: block.place,
    name,
  };
  const { setNodeRef, active, over } = useDroppable({
    id: dragId.noteBlock(subjectId, block.place),
    data,
    disabled: !canDrag(),
  });
  const held = active?.data.current as DragData | undefined;
  const target = over?.data.current as DragData | undefined;
  const lit =
    held?.type === "note_page" &&
    (target?.type === "note_page" || target?.type === "note_group_drop") &&
    target.subjectId === subjectId &&
    samePlace(target.place, block.place) &&
    notePageAccepts(held, block.place, subjectId) &&
    // Within its own block, the rows making room are the feedback.
    !samePlace(held.place, block.place);
  return (
    <section
      ref={setNodeRef}
      data-note-block
      aria-label={name}
      className={`mt-2 rounded-md ${lit ? "bg-selected" : ""}`}
    >
      {children}
    </section>
  );
}

function AddLine({
  label,
  onClick,
  wide,
}: {
  label: string;
  onClick: () => void;
  wide: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 text-left text-text-2 hover:bg-hover hover:text-text ${
        wide ? "h-8 text-[13px]" : "min-h-12 text-[15px]"
      }`}
    >
      <Plus size={wide ? 15 : 18} aria-hidden className="text-accent" />
      {label}
    </button>
  );
}

/** « + Nouveau groupe » on a large screen: a name field in place. */
function NewGroup({ subjectId }: { subjectId: string }) {
  const creating = useGroupRename((s) => s.creatingIn === subjectId);
  const stop = () => useGroupRename.setState({ creatingIn: null });
  if (!creating) {
    return (
      <AddLine
        wide
        label={fr.notes.newGroup}
        onClick={() => useGroupRename.setState({ creatingIn: subjectId })}
      />
    );
  }
  return (
    <InlineNameInput
      label={fr.notes.groupName}
      placeholder={fr.notes.groupName}
      onCancel={stop}
      onCommit={async (name) => {
        const ok = await createNoteGroup(subjectId, name);
        if (ok) stop();
        return ok;
      }}
    />
  );
}

export function NoteList({
  subjectId,
  notebook,
  selectedId,
  wide,
  onOpen,
}: {
  subjectId: string;
  notebook: NotebookView;
  /** The page shown beside the list (large screen). */
  selectedId: string | null;
  wide: boolean;
  onOpen: (pageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const folded = useUi((s) => s.foldedNoteGroups);
  const searching = query.trim().length > 0;
  const groups = notebook.groups.map((g) => g.group);
  const all = noteBlocks(notebook);
  const pagesOf = new Map(
    all.map((b) => [placeKey(b.place), b.pages.map((p) => p.id)]),
  );
  const { hits, failed, retry } = useNoteSearch(subjectId, query);
  // Until the first answer of a search, the list stays as it is (no flash of « Aucune page »).
  const blocks = filterBlocks(all, searching ? hits : undefined).filter(
    (b) =>
      b.pages.length > 0 ||
      // « Épinglées » and real groups show even empty (places to put pages), except in a
      // search; outside any group shows only with pages (« Déplacer vers › Sans groupe »).
      (!searching && (b.group !== null || b.place === "pinned")),
  );

  return (
    <nav aria-label={fr.notes.listLabel} className="flex min-w-0 flex-col">
      <div className="relative mb-2">
        <Search
          size={wide ? 14 : 17}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-3"
        />
        <input
          type="search"
          aria-label={fr.notes.search}
          placeholder={fr.notes.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
          className={`w-full rounded-md [&::-webkit-search-cancel-button]:appearance-none border border-border-input bg-bg pr-8 text-text placeholder:text-text-3 ${
            wide ? "h-8 pl-8 text-[13px]" : "h-11 pl-9 text-[16px]"
          }`}
        />
        {searching && (
          <button
            type="button"
            aria-label={fr.notes.clearSearch}
            onClick={() => setQuery("")}
            className={`absolute top-1/2 right-0.5 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-text-3 hover:text-text ${
              wide ? "h-7 w-7" : "h-10 w-10"
            }`}
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {searching && failed && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 px-2 py-3 text-[13.5px] text-text-2"
        >
          {fr.notes.searchFailed}
          <button
            type="button"
            onClick={retry}
            className={`rounded-md px-2 font-medium text-accent hover:underline ${
              wide ? "h-7" : "h-11"
            }`}
          >
            {fr.notes.searchRetry}
          </button>
        </p>
      )}

      {searching && !failed && hits !== undefined && blocks.length === 0 && (
        <p role="status" className="px-2 py-3 text-[13.5px] text-text-2">
          {fr.notes.noMatch(query.trim())}
        </p>
      )}

      {blocks.map((block) => {
        const name = blockName(block);
        const foldKey = foldKeyOf(subjectId, block);
        // A search shows its hits even in folded groups.
        const open = searching || foldKey === null || folded[foldKey] !== true;
        return (
          <Block
            key={placeKey(block.place)}
            subjectId={subjectId}
            block={block}
            name={name}
          >
            {foldKey && (
              <NoteGroupHeader
                name={name}
                foldKey={foldKey}
                group={block.group}
                wide={wide}
                count={block.pages.length}
              />
            )}
            {block.place === "pinned" && block.pages.length === 0 && open && (
              <p
                className={`flex items-center px-2 text-text-3 ${
                  wide ? "h-8 text-[13px]" : "min-h-12 text-[15px]"
                }`}
              >
                {wide ? fr.notes.pinnedEmptyWide : fr.notes.pinnedEmptyPhone}
              </p>
            )}
            <SortableContext
              items={open ? block.pages.map((p) => dragId.notePage(p.id)) : []}
              strategy={verticalListSortingStrategy}
            >
              {open &&
                block.pages.map((row) => (
                  <PageRow
                    key={row.id}
                    subjectId={subjectId}
                    row={row}
                    block={block}
                    blockPages={pagesOf.get(placeKey(block.place)) ?? []}
                    groups={groups}
                    selected={row.id === selectedId}
                    wide={wide}
                    searching={searching}
                    onOpen={() => onOpen(row.id)}
                  />
                ))}
            </SortableContext>
          </Block>
        );
      })}

      {/* Hidden during a search: it only filters. */}
      <div className="mt-3 flex flex-col" hidden={searching}>
        {wide && (
          <AddLine
            wide
            label={fr.notes.newPage}
            onClick={() => void createNotePage(subjectId, null, false)}
          />
        )}
        {wide ? (
          <NewGroup subjectId={subjectId} />
        ) : (
          <AddLine
            wide={false}
            label={fr.notes.newGroup}
            onClick={() => promptNewGroup(subjectId)}
          />
        )}
      </div>
    </nav>
  );
}
