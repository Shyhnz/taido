/**
 * Clickable chips under the panel title: « Projet › Section » opens a menu of
 * destinations (Sans projet included), « Échéance » opens the French date picker, « P1 »…
 * « P4 » opens the priority menu. Layout C (2026-10-11): borderless items,
 * no subtask counter (the « Sous-tâches » row says it), « Bloquée par » when it applies.
 */

import {
  Ban,
  CalendarDays,
  ChevronDown,
  CornerDownRight,
  Flag,
  Inbox,
} from "lucide-react";
import { useRef, useState } from "react";
import type { Subject, TaskDetail } from "../../bindings";
import { DatePickerPopover, type DueValue } from "../../components/DatePicker";
import { type MenuItem, openMenuAt } from "../../components/Menu";
import { fr } from "../../i18n/fr";
import { formatDue } from "../../lib/dates";
import { projectPath, sectionPath, subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { useSubjects } from "../../lib/queries";
import { run } from "../../lib/run";
import { priorityMenuItems } from "../task-row/actions";
import {
  clampPriority,
  displayPriority,
  priorityColor,
} from "../task-row/PriorityRing";
import { revealFold } from "./PanelFold";

// Layout C (2026-10-11): a quiet line of borderless items, not boxed chips.
const chipClass =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-text hover:bg-hover aria-expanded:bg-hover";

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

/** Text of the location: « Globex › Summit Events », « Globex » or « Sans projet ». */
/** « Globex › Client › Design »: a sub-project is named with its parent. */
export function locationText(
  task: TaskDetail,
  subjects: Subject[] = [],
): string {
  if (!task.subject) return fr.panel.noProject;
  const id = task.subject.id;
  const subject = subjects.find((s) => s.id === id) ?? {
    name: task.subject.name,
    parentId: null,
  };
  return task.section
    ? sectionPath(subject, task.section, subjects)
    : projectPath(subject, subjects);
}

function LocationChip({ task }: { task: TaskDetail }) {
  const subjects = useSubjects().data ?? [];

  const move = (subjectId: string | null, sectionId: string | null) => {
    if (
      subjectId === (task.subject?.id ?? null) &&
      sectionId === (task.section?.id ?? null)
    ) {
      return;
    }
    void run(
      commands.moveTask({ id: task.id, subjectId, sectionId, index: null }),
      fr.errors.action.moveTask,
    );
  };

  const items = (): MenuItem[] => {
    const list: MenuItem[] = [
      {
        label: fr.move.noProject,
        icon: <Inbox size={14} aria-hidden />,
        checked: task.subject === null,
        onSelect: () => move(null, null),
      },
    ];
    for (const s of subjects) {
      list.push({
        label: projectPath(s, subjects),
        icon: <Dot color={subjectColorVar(s.color)} />,
        checked: task.subject?.id === s.id && task.section === null,
        onSelect: () => move(s.id, null),
      });
      for (const section of s.sections) {
        list.push({
          label: sectionPath(s, section, subjects),
          icon: <CornerDownRight size={13} aria-hidden />,
          checked: task.section?.id === section.id,
          onSelect: () => move(s.id, section.id),
        });
      }
    }
    return list;
  };

  const text = locationText(task, subjects);
  // A subtask lives where its parent does: no move of its own.
  if (task.parent) {
    return (
      <span
        title={fr.panelBis.locationFromParent}
        data-chip="location"
        className={`${chipClass} hover:bg-bg`}
      >
        {task.subject ? (
          <Dot color={subjectColorVar(task.subject.color)} />
        ) : (
          <Inbox size={14} aria-hidden className="shrink-0 text-text-2" />
        )}
        <span className="truncate">{text}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={fr.panel.location(text)}
      title={text}
      onClick={(e) =>
        openMenuAt(e.currentTarget, items(), fr.panel.locationMenu)
      }
      className={chipClass}
    >
      {task.subject ? (
        <Dot color={subjectColorVar(task.subject.color)} />
      ) : (
        <Inbox size={14} aria-hidden className="shrink-0 text-text-2" />
      )}
      <span className="truncate">{text}</span>
      <ChevronDown size={13} aria-hidden className="shrink-0 text-text-2" />
    </button>
  );
}

/** Saves the due date picked for `task` (chip, or ⋯ in focus mode); no-op when unchanged. */
export function saveTaskDue(task: TaskDetail, value: DueValue): void {
  if (
    value.date === (task.due?.date ?? null) &&
    value.time === (task.due?.time ?? null)
  ) {
    return;
  }
  void run(
    commands.setTaskDue({
      id: task.id,
      date: value.date,
      time: value.date ? value.time : null,
    }),
    fr.errors.action.updateTask,
  );
}

function DueChip({ task }: { task: TaskDetail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const overdue = task.due?.overdue === true && task.completedAt === null;
  const label = task.due ? formatDue(task.due) : null;
  const save = (value: DueValue) => saveTaskDue(task, value);

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          label
            ? fr.panel.dueChip(
                overdue ? `${label}, ${fr.panel.dueOverdue}` : label,
              )
            : fr.panel.dueEmpty
        }
        onClick={() => setOpen((o) => !o)}
        className={`${chipClass} ${label ? "" : "text-text-2"}`}
      >
        <CalendarDays
          size={14}
          aria-hidden
          className={`shrink-0 ${overdue ? "text-due-overdue" : "text-text-2"}`}
        />
        <span className={`truncate ${overdue ? "text-due-overdue" : ""}`}>
          {label ?? fr.panel.dueEmpty}
        </span>
      </button>
      {open && (
        <DatePickerPopover
          anchorRef={ref}
          value={{ date: task.due?.date ?? null, time: task.due?.time ?? null }}
          onChange={save}
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) ref.current?.focus();
          }}
        />
      )}
    </>
  );
}

function PriorityFlag({ priority }: { priority: number }) {
  return (
    <Flag
      size={14}
      aria-hidden
      className="shrink-0"
      style={{ color: priorityColor(priority) }}
      fill={priority > 1 ? "currentColor" : "none"}
    />
  );
}

function PriorityChip({ task }: { task: TaskDetail }) {
  const p = clampPriority(task.priority);
  const shown = displayPriority(p);
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={fr.panelBis.priorityChip(shown)}
      title={fr.panelBis.priorityName(shown)}
      onClick={(e) =>
        openMenuAt(
          e.currentTarget,
          priorityMenuItems(task),
          fr.panelBis.priority,
        )
      }
      className={`${chipClass} ${p === 1 ? "text-text-2" : ""}`}
    >
      <PriorityFlag priority={p} />
      <span>{fr.panelBis.priorityShort(shown)}</span>
    </button>
  );
}

/**
 * « Bloquée par 2 »: blocking tasks not done yet change what to do, so they sit next to the
 * due date; a click opens « Relations ».
 */
function BlockedByItem({ task }: { task: TaskDetail }) {
  const n = task.relations.blockedBy.filter((r) => !r.completed).length;
  if (n === 0) return null;
  return (
    <button
      type="button"
      data-chip="blocked-by"
      aria-label={fr.folds.blockedByChipLabel(n)}
      onClick={() => revealFold("relations")}
      className={`${chipClass} text-due-overdue`}
    >
      <Ban size={14} aria-hidden className="shrink-0" />
      <span className="truncate">{fr.folds.blockedByChip(n)}</span>
    </button>
  );
}

/** Under the title: where, when, how urgent, and what blocks it. */
export function TaskChips({ task }: { task: TaskDetail }) {
  return (
    <div className="-ml-1.5 mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
      <LocationChip task={task} />
      <DueChip task={task} />
      <PriorityChip task={task} />
      <BlockedByItem task={task} />
    </div>
  );
}
