/**
 * Todoist-like task editor, in place in a list: title + note. Enter in a field adds and keeps
 * the editor open, Tab goes to the note, Shift+Enter adds a line to the note, Escape closes.
 * The destination and due chips are clickable. No natural language here: ⌘N,
 * `q` and « Nouvelle tâche » open the quick add (src/features/quick-add), which
 * reuses the draft helpers, the destination menu and the « Ajoutée dans X » toast below.
 */

import { CalendarDays, Inbox } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import type { AddTarget, Subject } from "../../bindings";
import { Button } from "../../components/Button";
import { DatePickerPopover, type DueValue } from "../../components/DatePicker";
import { announce } from "../../components/LiveRegion";
import { type MenuItem, openMenuAt } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { formatDue, todayString, tomorrowString } from "../../lib/dates";
import { features } from "../../lib/features";
import { projectPath, sectionPath, subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { useSubjects } from "../../lib/queries";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";

/**
 * Due date chosen in the editor. Relative on purpose: it is turned into a date when the task
 * is added, so an editor left open past midnight never adds tasks due yesterday.
 */
export type DueChoice =
  | "today"
  | "tomorrow"
  | { date: string; time: string | null }
  | null;

/** Where the next task goes; starts from the group's `AddTarget`. */
export interface Draft {
  subjectId: string | null;
  sectionId: string | null;
  due: DueChoice;
}

/**
 * The draft a group's add row starts from. `dueDate`: the day of a « Prochainement » group
 *; today and tomorrow stay relative like the picker's choices.
 */
export function draftFromTarget(target: AddTarget, dueDate?: string): Draft {
  let due: DueChoice = target.dueToday ? "today" : null;
  if (dueDate !== undefined) {
    due =
      dueDate === todayString()
        ? "today"
        : dueDate === tomorrowString()
          ? "tomorrow"
          : { date: dueDate, time: null };
  }
  return { subjectId: target.subjectId, sectionId: target.sectionId, due };
}

/** `YYYY-MM-DD` of a due choice, on the day `now`. */
export function dueDateOf(due: DueChoice, now = new Date()): string | null {
  if (due === "today") return todayString(now);
  if (due === "tomorrow") return tomorrowString(now);
  return due?.date ?? null;
}

/** Due time of a choice: only an explicit date from the picker carries one. */
export function dueTimeOf(due: DueChoice): string | null {
  return typeof due === "object" && due !== null ? due.time : null;
}

/**
 * Due choice for a value picked in the calendar: today or tomorrow without a time stay
 * relative (see `DueChoice`), anything else is kept as picked.
 */
export function dueChoiceOf(value: DueValue, now = new Date()): DueChoice {
  if (value.date === null) return null;
  if (value.time === null && value.date === todayString(now)) return "today";
  if (value.time === null && value.date === tomorrowString(now)) {
    return "tomorrow";
  }
  return { date: value.date, time: value.time };
}

/**
 * True when a task added with `draft` shows in the list the editor belongs to: Today keeps
 * only the tasks due today (any project); a project or « Sans projet » keeps its own tasks.
 */
export function addedInView(
  target: AddTarget,
  draft: Draft,
  /** A day of « Prochainement »: the task shows there when it keeps that day. */
  dueDate?: string,
): boolean {
  if (dueDate !== undefined) return dueDateOf(draft.due) === dueDate;
  if (target.dueToday) return dueDateOf(draft.due) === todayString();
  return draft.subjectId === target.subjectId;
}

/** « Globex › Summit Events », or « Sans projet ». */
export function destinationLabel(draft: Draft, subjects: Subject[]): string {
  const subject = subjects.find((s) => s.id === draft.subjectId);
  if (!subject) return t.sidebar.noProject;
  const section = subject.sections.find((s) => s.id === draft.sectionId);
  return section
    ? sectionPath(subject, section, subjects)
    : projectPath(subject, subjects);
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

export function destinationItems(
  draft: Draft,
  subjects: Subject[],
  set: (d: Draft) => void,
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: t.sidebar.noProject,
      icon: <Inbox size={13} aria-hidden />,
      checked: draft.subjectId === null ? true : undefined,
      onSelect: () => set({ ...draft, subjectId: null, sectionId: null }),
    },
  ];
  for (const s of subjects) {
    // A group holds no task.
    if (s.isGroup) continue;
    items.push({
      label: projectPath(s, subjects),
      icon: <Dot color={subjectColorVar(s.color)} />,
      checked:
        draft.subjectId === s.id && draft.sectionId === null ? true : undefined,
      onSelect: () => set({ ...draft, subjectId: s.id, sectionId: null }),
    });
    for (const section of s.sections) {
      items.push({
        label: sectionPath(s, section, subjects),
        checked: draft.sectionId === section.id ? true : undefined,
        onSelect: () =>
          set({ ...draft, subjectId: s.id, sectionId: section.id }),
      });
    }
  }
  return items;
}

const CHIP =
  "inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-border px-2 text-[12.5px] text-text-2 hover:bg-hover hover:text-text";

function Chips({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const subjects = useSubjects().data ?? [];
  const subject = subjects.find((s) => s.id === draft.subjectId);
  const where = destinationLabel(draft, subjects);
  const dueRef = useRef<HTMLButtonElement>(null);
  const [dueOpen, setDueOpen] = useState(false);
  const dueDate = dueDateOf(draft.due);
  const dueLabel = dueDate
    ? formatDue({ date: dueDate, time: dueTimeOf(draft.due) })
    : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label={t.editor.destination(where)}
        className={CHIP}
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            destinationItems(draft, subjects, setDraft),
            t.editor.projectMenu,
          )
        }
      >
        {subject ? (
          <Dot color={subjectColorVar(subject.color)} />
        ) : (
          <Inbox size={13} aria-hidden />
        )}
        <span className="truncate">{where}</span>
      </button>
      <button
        ref={dueRef}
        type="button"
        aria-label={dueLabel ? t.editor.due(dueLabel) : t.editor.noDue}
        aria-haspopup="dialog"
        aria-expanded={dueOpen}
        className={`${CHIP} ${dueLabel ? "" : "border-dashed"}`}
        onClick={() => setDueOpen((o) => !o)}
      >
        <CalendarDays size={13} aria-hidden />
        {dueLabel ?? t.editor.noDue}
      </button>
      {dueOpen && (
        <DatePickerPopover
          anchorRef={dueRef}
          value={{ date: dueDate, time: dueTimeOf(draft.due) }}
          onChange={(v) => setDraft({ ...draft, due: dueChoiceOf(v) })}
          onClose={(restoreFocus) => {
            setDueOpen(false);
            if (restoreFocus) dueRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * Says where a new task went: announced when it shows in the list the add started from,
 * else a toast « Ajoutée dans X · Voir » (a status, so announced too).
 */
export function notifyAdded(
  target: AddTarget,
  draft: Draft,
  title: string,
  subjects: Subject[],
  dueDate?: string,
): void {
  if (addedInView(target, draft, dueDate)) {
    announce(t.list.announce.added(title));
    return;
  }
  const where = destinationLabel({ ...draft, sectionId: null }, subjects);
  const subjectId = draft.subjectId;
  showToast({
    message: t.toast.added(where),
    action: {
      label: t.toast.see,
      onAction: () =>
        useUi
          .getState()
          .setView(
            subjectId
              ? { kind: "subject", subjectId }
              : { kind: "inbox", subjectId: null },
          ),
    },
  });
}

export function TaskEditor({
  target,
  dueDate,
  onClose,
}: {
  target: AddTarget;
  /** Prefilled due date (a day of « Prochainement »). */
  dueDate?: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromTarget(target, dueDate),
  );
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const subjects = useSubjects().data ?? [];

  const submit = async () => {
    const text = title.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    const task = await run(
      commands.createTask({
        title: text,
        description: description.trim().length > 0 ? description : null,
        subjectId: draft.subjectId,
        sectionId: draft.sectionId,
        dueDate: dueDateOf(draft.due),
        dueTime: dueTimeOf(draft.due),
      }),
      t.errors.action.createTask,
    );
    setBusy(false);
    if (!task) return;
    setTitle("");
    setDescription("");
    titleRef.current?.focus();
    notifyAdded(target, draft, task.title, subjects, dueDate);
  };

  // Bug #8: Enter only submits from the fields, never from the buttons.
  const onFieldKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the editor from any of its controls
    <div
      onKeyDown={onKeyDown}
      data-task-editor
      className="my-1 flex flex-col rounded-lg border border-border bg-bg focus-within:border-border-input"
    >
      <div className="flex flex-col gap-0.5 px-3 pt-2.5 pb-2">
        <input
          ref={titleRef}
          // biome-ignore lint/a11y/noAutofocus: the editor opens on an explicit user action
          autoFocus
          aria-label={t.addTask.titlePlaceholder}
          placeholder={t.addTask.titlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onFieldKeyDown}
          className="bg-transparent text-[14.5px] font-medium outline-hidden placeholder:text-text-3"
        />
        <textarea
          aria-label={t.addTask.descriptionPlaceholder}
          placeholder={t.addTask.descriptionPlaceholder}
          value={description}
          rows={1}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onFieldKeyDown}
          className="field-sizing-content resize-none bg-transparent text-[13px] text-text-2 outline-hidden placeholder:text-text-3"
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
        <Chips draft={draft} setDraft={setDraft} />
        <div className="flex shrink-0 items-center gap-2">
          {features.shortcuts && (
            <span className="hidden text-[12px] text-text-3 sm:inline">
              {t.addTask.hint}
            </span>
          )}
          <Button size="sm" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={title.trim().length === 0 || busy}
            onClick={() => void submit()}
          >
            {t.addTask.submit}
          </Button>
        </div>
      </div>
    </div>
  );
}
