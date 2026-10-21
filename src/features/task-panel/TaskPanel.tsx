/**
 * Task panel: one column, ~460 px by default, resizable and
 * capped to the window. Header (⋯ and ×); ring + title; chips « Projet › Section » and
 * « Échéance »; « Note »; « Sous-tâches »; « Historique » collapsed.
 *
 * Title and note are saved ~600 ms after the last keystroke and flushed on close, on task
 * switch (the panel is keyed by task) and on window unload (bug #2). The focus goes to the
 * title on open and back to the task's row on close.
 *
 * The « Session » block (terminals) sits between the chips and the note, using
 * the whole panel width; « Pleine largeur » (focus mode, ⌘⇧F) gives the panel the whole
 * window and « Ouvrir dans… » opens the working folder elsewhere. The technical details
 * (folder, git branch, state) are folded at the bottom.
 *
 * The ring is the priority ring (Todoist), Claude's state is a dot right of
 * the title; a subtask is a child task with the same panel, a « ‹ Parente » way back on top
 * and no « Sous-tâches » of its own (one level).
 *
 * Redesign option A (2026-10-04): no empty header, ⤢ ⋯ × sit on the title's line; the
 * note comes right under the title (Todoist), then the chips, the terminals, the subtasks,
 * and the folded « Conversations passées », technical details and journal. In focus mode the
 * panel is one 44 px bar and the terminals (FocusView): note and subtasks are not shown.
 *
 * Layout C (2026-10-11): title cut at 3 lines and note at 4 while not edited, a quiet
 * line « Projet · Échéance · P · Bloquée par » under the title, then the note, the terminals,
 * and folded sections with a summary (`PanelFold`); empty ones wait on an « Ajouter : … » line.
 * Focus mode is unchanged.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Clock,
  Ellipsis,
  Link2,
  ListChecks,
  Maximize2,
  Minimize2,
  Paperclip,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Editor, TaskDetail } from "../../bindings";
import { IconButton } from "../../components/Button";
import { DatePickerPopover } from "../../components/DatePicker";
import { type MenuItem, openMenuAt } from "../../components/Menu";
import { t } from "../../i18n";
import { features } from "../../lib/features";
import { commands, isNotFound } from "../../lib/ipc";
import { keys as osKeys } from "../../lib/platform";
import { queryKeys, useInstalledEditors, useSettings } from "../../lib/queries";
import { IS_MOBILE } from "../../lib/target";
import { useUi } from "../../stores/ui";
import { ChronoSection } from "../chrono/ChronoSection";
import { AttachmentsSection } from "../links/AttachmentsSection";
import { RelationsSection } from "../links/RelationsSection";
import { MentionLink } from "../notes/NotePage";
import { useTaskNoteMentions } from "../notes/queries";
import {
  duplicateTask,
  priorityMenuItems,
  setCompleted,
} from "../task-row/actions";
import { displayPriority, PriorityRing } from "../task-row/PriorityRing";
import { StateDot } from "../task-row/StateDot";
import { openTaskFolderIn, promptCommand } from "../terminals/actions";
import { FocusView, SessionBlock } from "../terminals/SessionBlock";
import { SessionHistory } from "../terminals/SessionHistory";
import { useDebouncedSave } from "./debouncedSave";
import { Journal } from "./Journal";
import { Fold, revealFold, usePanelFolds } from "./PanelFold";
import { deleteTaskWithUndo, focusTaskRow, saveTaskText } from "./panelActions";
import { usePanelWidth } from "./panelWidth";
import { ResizeHandle } from "./ResizeHandle";
import { Subtasks } from "./Subtasks";
import { saveTaskDue, TaskChips } from "./TaskChips";
import { TechnicalDetails } from "./TechnicalDetails";

/** Git branch refresh while the panel is open, only once it is shown (bug #3). */
export const GIT_REFRESH_MS = 30_000;

/**
 * The open task. The git branch is shown only with `features.terminals`: until then no
 * polling runs at all; afterwards the detail is refetched on open and every 30 s.
 */
export function usePanelTask(id: string) {
  return useQuery({
    queryKey: queryKeys.task(id),
    queryFn: () => commands.getTask(id),
    refetchInterval: features.terminals ? GIT_REFRESH_MS : false,
    refetchOnMount: features.terminals ? "always" : true,
  });
}

/**
 * Grows the field with its text. With `maxHeight`, says whether the text is taller than that:
 * the field is then shown cut (layout C) until it gets the focus or is unfolded.
 */
function useAutosize(value: string, maxHeight?: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (maxHeight !== undefined)
      setOverflowing(el.scrollHeight > maxHeight + 2);
  }, [value]);
  return { ref, overflowing };
}

/** Title shown on 3 lines at most, the note on 4, while not edited (layout C). */
const TITLE_MAX_HEIGHT = 3 * 28;
const NOTE_MAX_HEIGHT = 4 * 21 + 4;
/** Fades the last line of a cut field. */
const CUT_FADE =
  "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]";

/**
 * Local copy of a server text: follows the server while the field is not being edited, never
 * overwrites what the user is typing (the saved, trimmed value comes back mid-typing).
 */
function useEditableText(serverValue: string) {
  const [value, setValue] = useState(serverValue);
  const [focused, setFocused] = useState(false);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(serverValue);
  }, [serverValue]);
  return {
    value,
    setValue,
    focused,
    onFocus: () => {
      editing.current = true;
      setFocused(true);
    },
    onBlur: () => {
      editing.current = false;
      setFocused(false);
    },
  };
}

/** Title as saved: one line, single spaces, trimmed. */
export const normalizeTitle = (value: string) =>
  value.replace(/\s+/g, " ").trim();

function TitleAndNote({
  task,
  actions,
}: {
  task: TaskDetail;
  actions: ReactNode;
}) {
  const title = useEditableText(task.title);
  const note = useEditableText(task.description);
  const { ref: titleRef, overflowing: titleLong } = useAutosize(
    title.value,
    TITLE_MAX_HEIGHT,
  );
  const { ref: noteRef, overflowing: noteLong } = useAutosize(
    note.value,
    NOTE_MAX_HEIGHT,
  );
  const [noteOpen, setNoteOpen] = useState(false);
  const titleCut = titleLong && !title.focused;
  const noteCut = noteLong && !note.focused && !noteOpen;
  // Last values sent, to skip no-op saves.
  const sent = useRef({ title: task.title, description: task.description });
  useEffect(() => {
    sent.current.title = task.title;
  }, [task.title]);
  useEffect(() => {
    sent.current.description = task.description;
  }, [task.description]);

  const titleSave = useDebouncedSave((value) => {
    const trimmed = normalizeTitle(value);
    if (trimmed.length === 0 || trimmed === sent.current.title) return;
    sent.current.title = trimmed;
    void saveTaskText(task.id, { title: trimmed });
  });
  const noteSave = useDebouncedSave((value) => {
    if (value === sent.current.description) return;
    sent.current.description = value;
    void saveTaskText(task.id, { description: value });
  });

  // Focus the title on open, caret at the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mounted task
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <PriorityRing
            priority={task.priority}
            completed={task.completedAt !== null}
            size={20}
            onToggle={() =>
              void setCompleted(task.id, task.completedAt === null)
            }
          />
        </div>
        <textarea
          ref={titleRef}
          rows={1}
          aria-label={t.panel.titleLabel}
          value={title.value}
          onFocus={title.onFocus}
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, " ");
            title.setValue(v);
            titleSave.schedule(v);
          }}
          onBlur={() => {
            title.onBlur();
            titleSave.flush();
            // An emptied title goes back to the saved one; otherwise show what was saved.
            const normalized = normalizeTitle(title.value);
            title.setValue(normalized.length === 0 ? task.title : normalized);
          }}
          onKeyDown={onTitleKey}
          title={titleCut ? title.value : undefined}
          style={titleCut ? { maxHeight: TITLE_MAX_HEIGHT } : undefined}
          className={`-mx-1.5 min-w-0 flex-1 resize-none overflow-hidden rounded-md bg-transparent px-1.5 text-[18px] leading-7 font-semibold outline-none hover:bg-hover focus:bg-hover ${
            task.completedAt ? "text-text-3 line-through" : ""
          } ${titleCut ? CUT_FADE : ""}`}
        />
        {/* Claude's state, right of the name, while no tab shows it. */}
        {task.completedAt === null && task.terminals.length === 0 && (
          <span className="flex h-7 shrink-0 items-center">
            <StateDot
              ring={task.ring}
              agent={task.line?.agent ?? undefined}
              size={14}
            />
          </span>
        )}
        {actions && (
          <div className="-mt-px -mr-2 flex shrink-0 items-center gap-0.5">
            {actions}
          </div>
        )}
      </div>

      <div className="pl-8">
        {/* Layout C: where, when, how urgent, then the note, then Claude. */}
        <TaskChips task={task} />
        <textarea
          ref={noteRef}
          rows={1}
          aria-label={t.panel.noteTitle}
          placeholder={t.panel.descriptionPlaceholder}
          value={note.value}
          onFocus={note.onFocus}
          onChange={(e) => {
            note.setValue(e.target.value);
            noteSave.schedule(e.target.value);
          }}
          onBlur={() => {
            note.onBlur();
            noteSave.flush();
          }}
          style={noteCut ? { maxHeight: NOTE_MAX_HEIGHT } : undefined}
          className={`-mx-1.5 mt-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-md bg-transparent px-1.5 py-0.5 text-[13.5px] leading-[21px] text-text-2 outline-none placeholder:text-text-3 hover:bg-hover focus:bg-hover focus:text-text ${
            noteCut ? CUT_FADE : ""
          }`}
        />
        {(noteCut || (noteOpen && noteLong && !note.focused)) && (
          <button
            type="button"
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((o) => !o)}
            className="-ml-1 mt-0.5 rounded-md px-1 py-0.5 text-[12.5px] text-text-2 hover:bg-hover hover:text-text"
          >
            {noteOpen ? t.folds.hideNote : t.folds.showNote}
          </button>
        )}
      </div>
      {features.terminals && <SessionBlock task={task} />}
    </>
  );
}

/**
 * Rarer actions, in the ⋯ menu: Claude, the shell and the Finder are one click away in the
 * panel itself. Leaving the app for an editor is rare.
 * « Ouvrir dans › » opens its list in place (`openSubmenu`).
 */
export function terminalMenuItems(
  taskId: string,
  editors: readonly Editor[],
  openSubmenu: (items: MenuItem[], label: string) => void,
): MenuItem[] {
  return [
    {
      label: t.terminals.runCommand,
      onSelect: () => void promptCommand(taskId),
    },
    {
      label: t.terminals.openIn,
      hint: "›",
      onSelect: () =>
        openSubmenu(openInItems(taskId, editors), t.terminals.openIn),
    },
    { separator: true },
  ];
}

/**
 * « Ouvrir dans » (2026-10-11, option A, like GitHub Desktop): the editors installed on this
 * Mac, the last used first, then the Finder and Terminal. Nothing to set in Réglages.
 */
export function openInItems(
  taskId: string,
  editors: readonly Editor[],
): MenuItem[] {
  return [
    ...editors.map(
      (editor): MenuItem => ({
        label: t.editors[editor],
        onSelect: () => void openTaskFolderIn(taskId, "editor", editor),
      }),
    ),
    ...(editors.length > 0 ? [{ separator: true } as const] : []),
    {
      label: t.terminals.finder,
      onSelect: () => void openTaskFolderIn(taskId, "finder"),
    },
    {
      label: t.terminals.terminal,
      onSelect: () => void openTaskFolderIn(taskId, "terminal"),
    },
  ];
}

/** The installed editors, the last used first. */
function editorsLastUsedFirst(
  installed: readonly Editor[],
  last: Editor | undefined,
): Editor[] {
  return last !== undefined && installed.includes(last)
    ? [last, ...installed.filter((e) => e !== last)]
    : [...installed];
}

/** « ‹ Parente »: the way back from a subtask's panel to its parent's. */
function ParentLink({ id, title }: { id: string; title: string }) {
  const openTask = useUi((s) => s.openTask);
  return (
    <button
      type="button"
      aria-label={t.panelBis.backToParent(title)}
      title={title}
      onClick={() => openTask(id)}
      className="-ml-1 mb-2 inline-flex max-w-full items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] text-text-2 hover:bg-hover hover:text-text"
    >
      <ChevronLeft size={14} aria-hidden className="shrink-0" />
      <span className="truncate">{title}</span>
    </button>
  );
}

/**
 * ⤢ ⋯ × of the panel, on the title's line (and in the focus bar). In focus mode the chips are
 * gone: ⋯ also offers « Échéance… » and a way back to the note and subtasks.
 */
function PanelActions({ task }: { task: TaskDetail | undefined }) {
  const lastEditor = useSettings().data?.editor;
  const installed = useInstalledEditors(features.terminals).data ?? [];
  const editors = editorsLastUsedFirst(installed, lastEditor);
  const openTask = useUi((s) => s.openTask);
  const openDialog = useUi((s) => s.openDialog);
  const focusMode = useUi((s) => s.focusMode);
  const setFocusMode = useUi((s) => s.setFocusMode);
  const moreRef = useRef<HTMLSpanElement>(null);
  const [dueOpen, setDueOpen] = useState(false);

  const openMore = (anchor: HTMLElement) => {
    if (!task) return;
    openMenuAt(
      anchor,
      [
        ...(focusMode
          ? [
              {
                label: t.terminals.due,
                onSelect: () => setDueOpen(true),
              },
            ]
          : []),
        {
          label: t.panelBis.priorityMenuItem,
          hint: t.panelBis.priorityShort(displayPriority(task.priority)),
          // A submenu in place: the four priorities under the same button.
          onSelect: () =>
            openMenuAt(
              anchor,
              priorityMenuItems(task),
              t.panelBis.priority,
              true,
            ),
        },
        // A subtask moves with its parent.
        ...(task.parent
          ? []
          : [
              {
                label: t.panel.move,
                onSelect: () =>
                  openDialog({ type: "moveTask", taskId: task.id }),
              },
            ]),
        ...(focusMode
          ? [
              {
                label: t.terminals.noteAndSubtasks,
                hint: t.terminals.leavesFocus,
                onSelect: () => setFocusMode(false),
              },
            ]
          : []),
        { separator: true },
        ...(features.terminals
          ? terminalMenuItems(task.id, editors, (items, label) =>
              openMenuAt(anchor, items, label, true),
            )
          : []),
        {
          label: t.panel.duplicate,
          onSelect: () => void duplicateTask(task.id),
        },
        { separator: true },
        {
          label: t.panel.delete,
          danger: true,
          onSelect: () => void deleteTaskWithUndo(task.id),
        },
      ],
      t.panel.more,
      true,
    );
  };

  return (
    <>
      {features.focusMode && !IS_MOBILE && (
        <IconButton
          label={focusMode ? t.terminals.leaveFullWidth : t.terminals.fullWidth}
          title={`${
            focusMode ? t.terminals.leaveFullWidth : t.terminals.fullWidth
          } (${osKeys("⌘⇧F")}${focusMode ? `, ${t.shortcuts.escape}` : ""})`}
          aria-pressed={focusMode}
          onClick={() => setFocusMode(!focusMode)}
        >
          {focusMode ? (
            <Minimize2 size={15} aria-hidden />
          ) : (
            <Maximize2 size={15} aria-hidden />
          )}
        </IconButton>
      )}
      <span ref={moreRef} className="inline-flex">
        <IconButton
          label={t.panel.more}
          aria-haspopup="menu"
          disabled={!task}
          onClick={(e) => openMore(e.currentTarget)}
        >
          <Ellipsis size={16} aria-hidden />
        </IconButton>
      </span>
      {!IS_MOBILE && (
        <IconButton label={t.panel.close} onClick={() => openTask(null)}>
          <X size={17} aria-hidden />
        </IconButton>
      )}
      {dueOpen && task && (
        <DatePickerPopover
          anchorRef={moreRef}
          value={{ date: task.due?.date ?? null, time: task.due?.time ?? null }}
          onChange={(value) => saveTaskDue(task, value)}
          onClose={(restoreFocus) => {
            setDueOpen(false);
            if (restoreFocus) moreRef.current?.querySelector("button")?.focus();
          }}
        />
      )}
    </>
  );
}

/** Ring and title in the focus bar: one line, edited in place on click. */
function FocusTitle({ task }: { task: TaskDetail }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = normalizeTitle(value);
    if (save && next.length > 0 && next !== task.title) {
      void saveTaskText(task.id, { title: next });
    }
  };

  return (
    <>
      <PriorityRing
        priority={task.priority}
        completed={task.completedAt !== null}
        size={15}
        onToggle={() => void setCompleted(task.id, task.completedAt === null)}
      />
      {editing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field replaces the title the user clicked
          autoFocus
          aria-label={t.panel.titleLabel}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              // Escape cancels the edit, it does not leave focus mode.
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
          className="ml-1 h-7 w-[260px] min-w-[120px] shrink rounded-md bg-hover px-1.5 text-[14px] font-semibold outline-none"
        />
      ) : (
        <button
          type="button"
          title={`${task.title} · ${t.terminals.editTitle}`}
          onClick={() => {
            done.current = false;
            setValue(task.title);
            setEditing(true);
          }}
          className={`ml-1 min-w-[40px] shrink truncate rounded-md px-1.5 py-0.5 text-left text-[14px] font-semibold hover:bg-hover ${
            task.completedAt ? "text-text-3 line-through" : ""
          }`}
        >
          {task.title}
        </button>
      )}
    </>
  );
}

type AddableFold = "subtasks" | "attachments" | "relations" | "chrono";

const ADD_ICONS: Record<AddableFold, ReactNode> = {
  subtasks: <ListChecks size={14} aria-hidden />,
  attachments: <Paperclip size={14} aria-hidden />,
  relations: <Link2 size={14} aria-hidden />,
  chrono: <Clock size={14} aria-hidden />,
};

/**
 * The folded sections under the terminals (layout C, 2026-10-11). An empty section is
 * not shown: it is offered on the last line, « Ajouter : Sous-tâche · Fichier · Lien ·
 * Temps », and opens for this task when clicked. Keyed by task: the opened ones reset.
 */
/** « Mentionné dans les notes »: the notebook pages that link this task, when there are any. */
function NoteMentions({ taskId }: { taskId: string }) {
  const items = useTaskNoteMentions(taskId).data ?? [];
  if (items.length === 0) return null;
  return (
    <Fold
      id="mentions"
      title={t.notes.mentionedInNotes}
      summary={items.length}
      defaultOpen
    >
      <ul className="flex flex-col">
        {items.map((item) => (
          <MentionLink
            key={item.id}
            item={item}
            // The phone shows one sheet at a time: the page's.
            onOpen={
              IS_MOBILE ? () => useUi.getState().openTask(null) : undefined
            }
          />
        ))}
      </ul>
    </Fold>
  );
}

function PanelSections({ task }: { task: TaskDetail }) {
  const forced = usePanelFolds((s) => s.forced);
  const resetForced = usePanelFolds((s) => s.resetForced);
  useEffect(() => () => resetForced(), [resetForced]);

  const { blocks, blockedBy, related } = task.relations;
  // One level only: a subtask has no subtasks.
  const filled: Partial<Record<AddableFold, boolean>> = {
    ...(task.parent ? {} : { subtasks: task.subtasks.length > 0 }),
    attachments: task.attachments.length > 0,
    relations: blocks.length + blockedBy.length + related.length > 0,
    chrono: task.time.segments.length > 0,
  };
  const keys = Object.keys(filled) as AddableFold[];
  const shown = (k: AddableFold) => filled[k] === true || forced[k] === true;
  const empty = keys.filter((k) => !shown(k));
  const adding = (k: AddableFold) => forced[k] === true && !filled[k];

  return (
    <div className="mt-6 pl-8">
      <div className="border-b border-border">
        {shown("subtasks") && (
          <Subtasks
            taskId={task.id}
            subtasks={task.subtasks}
            startAdding={adding("subtasks")}
          />
        )}
        {shown("attachments") && <AttachmentsSection task={task} />}
        {shown("relations") && (
          <RelationsSection task={task} startAdding={adding("relations")} />
        )}
        {shown("chrono") && (
          <ChronoSection task={task} startAdding={adding("chrono")} />
        )}
        <NoteMentions taskId={task.id} />
        {features.terminals && <SessionHistory task={task} />}
        {features.terminals && <TechnicalDetails task={task} />}
        {features.journal && <Journal taskId={task.id} />}
        {empty.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border py-1.5 text-[13px]">
            <span className="mr-1 text-text-3">{t.folds.addLabel}</span>
            {empty.map((k) => (
              <button
                key={k}
                type="button"
                // A file dropped on « Fichier » becomes an attachment, like on the zone.
                data-attach-task={k === "attachments" ? task.id : undefined}
                onClick={() => revealFold(k)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-text-2 hover:bg-hover hover:text-text"
              >
                {ADD_ICONS[k]}
                {t.folds.add[k]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** No element holds the focus (it is on the body, or on an element just removed). */
function focusIsFree(): boolean {
  const active = document.activeElement;
  return !(
    active instanceof HTMLElement &&
    active !== document.body &&
    active.isConnected
  );
}

export function TaskPanel({ taskId }: { taskId: string }) {
  const openTask = useUi((s) => s.openTask);
  const focusMode = useUi((s) => s.focusMode);
  const { data: task, error } = usePanelTask(taskId);
  const { width, max, setWidth, commit } = usePanelWidth();
  const focus = focusMode && !IS_MOBILE;

  // The task was deleted elsewhere: close the panel.
  useEffect(() => {
    if (error && isNotFound(error)) openTask(null);
  }, [error, openTask]);

  // Closing the panel (×, Escape, delete…) puts the focus back on the task's row. Switching to
  // another task remounts the panel, which then focuses its own title.
  // Leaves the focus alone when it was already moved somewhere useful: checked again on the
  // frame, as a dialog opened meanwhile (⌘N right after Escape) holds the focus by then.
  useEffect(
    () => () => {
      if (useUi.getState().openTaskId !== null || !focusIsFree()) return;
      requestAnimationFrame(() => {
        if (useUi.getState().openTaskId === null && focusIsFree()) {
          focusTaskRow(taskId);
        }
      });
    },
    [taskId],
  );

  const actions = <PanelActions task={task} />;

  let body: ReactNode;
  if (!task) {
    body = (
      <>
        {!IS_MOBILE && (
          <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 px-3">
            {actions}
          </div>
        )}
        <p className="p-6 text-[13.5px] text-text-2">
          {error ? t.panel.notFound : t.panel.loading}
        </p>
      </>
    );
  } else if (focus) {
    body = (
      <FocusView
        key={task.id}
        task={task}
        lead={<FocusTitle task={task} />}
        actions={actions}
      />
    );
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-10">
        {task.parent && (
          <ParentLink id={task.parent.id} title={task.parent.title} />
        )}
        <TitleAndNote
          key={task.id}
          task={task}
          actions={IS_MOBILE ? null : actions}
        />
        <PanelSections key={`sections-${task.id}`} task={task} />
      </div>
    );
  }

  return (
    <section
      aria-label={t.panel.label}
      className={`relative flex h-full flex-col bg-bg ${
        focus || IS_MOBILE
          ? "min-w-0 flex-1"
          : "shrink-0 border-l border-border"
      }`}
      style={focus || IS_MOBILE ? undefined : { width }}
    >
      {!focus && !IS_MOBILE && (
        <ResizeHandle
          width={width}
          max={max}
          onResize={setWidth}
          onCommit={commit}
        />
      )}
      {/* The phone shows the panel as a full-screen sheet (docs/SYNC.md § 6.4). */}
      {IS_MOBILE && (
        <header className="flex h-[52px] shrink-0 items-center justify-end gap-1 px-3">
          <button
            type="button"
            onClick={() => openTask(null)}
            className="order-first mr-auto inline-flex h-11 items-center gap-1 rounded-md px-2 text-[15px] text-text-2"
          >
            <ChevronLeft size={18} aria-hidden />
            {t.mobile.back}
          </button>
          {actions}
        </header>
      )}
      {body}
    </section>
  );
}
