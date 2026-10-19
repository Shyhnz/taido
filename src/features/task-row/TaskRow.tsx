/**
 * One task of a list: a single ~38 px line with the round checkbox, the title
 * and, on the right, only what exists: note icon, subtasks « 1/3 », due date, and the project
 * label in transverse views. The description never shows. The second line is
 * reserved for Claude's state and appears only when there is one.
 *
 * The checkbox is Todoist's, coloured by priority (`PriorityRing`);
 * Claude's state is a small dot right of the title (`StateDot`); a task with subtasks has a
 * chevron on its left that folds them.
 */

import {
  ChevronDown,
  ChevronRight,
  Clock,
  Ellipsis,
  FolderInput,
  SquareTerminal,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import { useRef } from "react";
import type {
  LineTone,
  SubjectColor,
  TaskLine,
  TaskRow as TaskRowData,
} from "../../bindings";
import { fr } from "../../i18n/fr";
import { formatDue, formatDueMeta, formatRelative } from "../../lib/dates";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { ChronoBadge } from "../chrono/ChronoBadge";
import { LinkBadges } from "../links/LinkBadges";
import type { CompletionPhase } from "./actions";
import { PriorityRing } from "./PriorityRing";
import { StateDot } from "./StateDot";
import { useFitBadges } from "./useFitBadges";
import "./taskRow.css";

const noop = () => {};

export const TONE_CLASS: Record<LineTone, string> = {
  waiting: "text-waiting-text",
  done: "text-done-text",
  primary: "text-text",
  muted: "text-text-2",
  faint: "text-text-3",
};

/** Final text of a second line. */
export function lineText(line: TaskLine, now: Date = new Date()): string {
  const when = line.at ? formatRelative(line.at, now) : null;
  switch (line.kind) {
    case "completed":
      return fr.line.completed(when);
    case "paused":
      return fr.line.paused(when);
    default:
      return fr.line[line.kind](line.text, line.agent ?? "claude");
  }
}

/** Project label of transverse views: colored dot + name, 12 px gray. */
export function SubjectTagLabel({
  name,
  color,
  className = "",
}: {
  name: string;
  color: SubjectColor;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: subjectColorVar(color) }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Note icon (three lines), drawn like the wireframe's « ≡ ». */
function NoteIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M3 4.5h10M3 8h10M3 11.5h6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface TaskRowProps {
  row: TaskRowData;
  selected?: boolean;
  onOpen?: () => void;
  onToggle?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  /** Drag handle shown on hover, on the left. */
  dragHandle?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragging?: boolean;
  /** Clock for relative dates (tests). */
  now?: Date;
  /**
   * Roving tabindex (one tab stop per list): 0 for the active row, -1 for the others.
   * Inner buttons then leave the tab order. Omitted: a plain, standalone row.
   */
  tabIndex?: number;
  focusRef?: Ref<HTMLButtonElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
  /** Completion animation in progress. */
  completing?: CompletionPhase;
  /** ⋯ button (visible on hover and focus). */
  onMenu?: (anchor: HTMLElement) => void;
  /** « Ranger dans… » button (tasks of « Sans projet »). */
  onFile?: (anchor: HTMLElement) => void;
  /**
   * The date the row's group already shows (Today: today; « Prochainement »: the day). A
   * due date on that day says nothing new: only its time shows, or nothing without time.
   */
  shownDate?: string;
  /**
   * The row's subtasks are unfolded (chevron down). With `onToggleChildren`,
   * a task that has subtasks shows the chevron on its left.
   */
  childrenOpen?: boolean;
  onToggleChildren?: () => void;
}

export function TaskRow({
  row,
  selected = false,
  onOpen,
  onToggle,
  onContextMenu,
  dragHandle,
  containerRef,
  style,
  dragging = false,
  now,
  tabIndex,
  focusRef,
  onKeyDown,
  onFocus,
  completing,
  onMenu,
  onFile,
  shownDate,
  childrenOpen = false,
  onToggleChildren,
}: TaskRowProps) {
  const completed = row.completedAt !== null || row.ring === "completed";
  const clock = now ?? new Date();
  const inner = tabIndex === undefined ? undefined : -1;
  const showTerminals = features.terminals && row.openTerminals > 0;
  const dateShown = row.due !== null && row.due.date === shownDate;
  const showDue = row.due !== null && !(dateShown && row.due.time === null);
  const overdue = row.due?.overdue === true && !completed;
  // The second line only exists for agent states.
  const line = features.states ? row.line : null;
  const badgesRef = useRef<HTMLSpanElement>(null);
  useFitBadges(badgesRef);
  const chevron = onToggleChildren !== undefined && row.children.length > 0;
  const Chevron = childrenOpen ? ChevronDown : ChevronRight;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the title button is the keyboard entry point; the row click is a pointer shortcut
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users open the task with Enter on the title button
    <div
      ref={containerRef}
      style={style}
      data-task-id={row.id}
      data-selected={selected || undefined}
      data-completing={completing}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className={`task-row group relative flex cursor-pointer flex-col rounded-lg px-2 ${
        selected ? "bg-selected" : "hover:bg-hover"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex h-[38px] min-w-0 items-center gap-2.5">
        {dragHandle && (
          <div
            className={`absolute top-[7px] opacity-0 transition-opacity group-hover:opacity-100 ${
              chevron ? "-left-[36px]" : "-left-6"
            }`}
          >
            {dragHandle}
          </div>
        )}
        {chevron && (
          <button
            type="button"
            tabIndex={inner}
            aria-expanded={childrenOpen}
            aria-label={
              childrenOpen
                ? fr.nesting.collapse(row.title)
                : fr.nesting.expand(row.title)
            }
            title={
              childrenOpen
                ? fr.nesting.collapse(row.title)
                : fr.nesting.expand(row.title)
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleChildren?.();
            }}
            data-children-toggle={row.id}
            className="touch-target absolute top-[9px] -left-[18px] inline-flex h-5 w-5 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
          >
            <Chevron size={15} aria-hidden />
          </button>
        )}
        <PriorityRing
          priority={row.priority}
          completed={completed || completing !== undefined}
          size={20}
          onToggle={onToggle ?? noop}
          tabIndex={inner}
          animate={completing !== undefined}
        />
        <button
          type="button"
          ref={focusRef}
          data-row-focus={row.id}
          tabIndex={tabIndex}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onClick={(e) => {
            e.stopPropagation();
            onOpen?.();
          }}
          className={`task-row-title min-w-[40%] truncate text-left text-[14.5px] leading-5 ${
            completed ? "text-text-3 line-through" : "text-text"
          }`}
        >
          <span className="task-row-strike">{row.title}</span>
        </button>
        {/* Claude's state, right of the title like the project dot of the sidebar. */}
        {features.states && (
          <StateDot ring={row.ring} agent={row.line?.agent ?? undefined} />
        )}
        <span className="min-w-0 flex-1" />
        {/* On a narrow screen (phone) the title keeps its room: a badge that does not fit is
            hidden whole (useFitBadges), never cut mid-word. */}
        <span
          ref={badgesRef}
          className="flex shrink-0 items-center gap-3 whitespace-nowrap text-[12px] leading-4 text-text-2"
        >
          {row.hasDescription && (
            <span className="inline-flex items-center" title={fr.list.hasNote}>
              <NoteIcon />
              <span className="sr-only">{fr.list.hasNote}</span>
            </span>
          )}
          {row.subtasksTotal > 0 && (
            <span
              className="tabular-nums"
              title={fr.row.subtasksLabel(row.subtasksDone, row.subtasksTotal)}
            >
              {fr.row.subtasks(row.subtasksDone, row.subtasksTotal)}
            </span>
          )}
          {showDue && row.due && (
            <span
              className={`inline-flex items-center gap-1 ${overdue ? "text-due-overdue" : ""}`}
              title={fr.row.dueLabel(formatDue(row.due, clock))}
              data-overdue={overdue || undefined}
            >
              {row.due.time && <Clock size={12} aria-hidden />}
              {/* Taido V2.4 (wireframe V2·1): « En retard · 7 oct. », like the kanban card. */}
              {overdue
                ? `${fr.row.overdue} · ${formatDueMeta(row.due, clock)}`
                : dateShown
                  ? row.due.time
                  : formatDueMeta(row.due, clock)}
            </span>
          )}
          <LinkBadges row={row} inRow />
          {row.chrono && <ChronoBadge chrono={row.chrono} />}
          {showTerminals && (
            <span className="inline-flex items-center gap-1">
              <SquareTerminal size={13} aria-hidden />
              {fr.row.sessions(row.openTerminals)}
            </span>
          )}
          {row.subject && (
            <SubjectTagLabel
              name={row.subject.name}
              color={row.subject.color}
              className="max-w-[160px]"
            />
          )}
        </span>
        {(onFile || onMenu) && (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {onFile && (
              <button
                type="button"
                tabIndex={inner}
                aria-label={fr.list.fileLabel(row.title)}
                title={fr.list.file}
                onClick={(e) => {
                  e.stopPropagation();
                  onFile(e.currentTarget);
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
              >
                <FolderInput size={15} aria-hidden />
              </button>
            )}
            {onMenu && (
              <button
                type="button"
                tabIndex={inner}
                aria-label={fr.list.more(row.title)}
                title={fr.common.more}
                onClick={(e) => {
                  e.stopPropagation();
                  onMenu(e.currentTarget);
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
              >
                <Ellipsis size={15} aria-hidden />
              </button>
            )}
          </span>
        )}
      </div>
      {line && (
        <div
          data-tone={line.tone}
          className={`-mt-1.5 truncate pb-2 pl-[30px] text-[13px] leading-[18px] ${TONE_CLASS[line.tone]}`}
        >
          {lineText(line, clock)}
        </div>
      )}
    </div>
  );
}
