/**
 * The round checkbox of a task, Todoist style: its outline says the
 * priority (shown P1 red, P2 orange, P3 yellow, P4 plain, with a light tinted fill), a check
 * says the user completed it. Claude's state no longer lives here: see `StateDot`, right of
 * the title.
 *
 * Stored priorities go the other way (1 plain … 4 red, as synced): `displayPriority` gives
 * the number the user sees.
 *
 * Shared by the lists, the task panel and the search palette. Colours are the
 * `--priority-*` tokens of src/styles/tokens.css.
 */

import type { MouseEvent } from "react";
import { t } from "../../i18n";

export type PriorityRingSize = 15 | 20 | 24;

/** 1 to 4; anything else is drawn as the plain priority 1. */
export function clampPriority(priority: number): 1 | 2 | 3 | 4 {
  return priority === 2 || priority === 3 || priority === 4 ? priority : 1;
}

/**
 * Number the user sees, Todoist style (2026-10-06): P1 is the most urgent. The stored
 * value is unchanged, so stored 4 (red) is P1, 3 (orange) P2, 2 (yellow) P3, 1 (plain) P4.
 */
export function displayPriority(priority: number): 1 | 2 | 3 | 4 {
  return (5 - clampPriority(priority)) as 1 | 2 | 3 | 4;
}

/** Outline colour of a priority (the `--priority-N` token), for flags and chips. */
export function priorityColor(priority: number): string {
  return `var(--priority-${clampPriority(priority)})`;
}

interface Look {
  stroke: string;
  fill: string;
  /** Fill of the completed ring (the check is drawn on it). */
  done: string;
}

const LOOKS: Record<1 | 2 | 3 | 4, Look> = {
  1: {
    stroke: "var(--priority-1)",
    fill: "none",
    done: "var(--state-completed)",
  },
  2: {
    stroke: "var(--priority-2)",
    fill: "var(--priority-2-fill)",
    done: "var(--priority-2)",
  },
  3: {
    stroke: "var(--priority-3)",
    fill: "var(--priority-3-fill)",
    done: "var(--priority-3)",
  },
  4: {
    stroke: "var(--priority-4)",
    fill: "var(--priority-4-fill)",
    done: "var(--priority-4)",
  },
};

const CHECK = "M6.3 10.3l2.5 2.4 5-5.2";

/** Accessible name of the checkbox: « Terminer », « Terminer · Priorité 1 », « Rouvrir ». */
export function priorityRingLabel(
  priority: number,
  completed: boolean,
): string {
  if (completed) return t.priorityRing.reopen;
  return t.priorityRing.markDone(displayPriority(priority));
}

/** The drawing alone (no button), for static places and the inside of the button. */
export function PriorityRingSvg({
  priority,
  completed,
  size,
  preview = false,
  animate = false,
}: {
  priority: number;
  completed: boolean;
  size: PriorityRingSize;
  /** Hover check preview (shown by the parent's `group/ring` hover), like Todoist. */
  preview?: boolean;
  /** Completion animation: the circle fills and the check draws itself. */
  animate?: boolean;
}) {
  const p = clampPriority(priority);
  const look = LOOKS[p];
  const filled = completed || animate;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-priority={p}
      data-completed={filled || undefined}
      data-animate={animate || undefined}
      className={`block shrink-0 overflow-visible ${animate ? "ring-complete" : ""}`}
    >
      <circle
        data-part="base"
        cx="10"
        cy="10"
        r="8.4"
        fill={filled ? look.done : look.fill}
        stroke={filled ? look.done : look.stroke}
        strokeWidth={p === 1 ? 1.6 : 1.9}
      />
      {filled && (
        <path
          data-part="check"
          pathLength={1}
          d={CHECK}
          fill="none"
          stroke="var(--ring-check-on-fill)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {preview && !filled && (
        <path
          data-part="preview"
          className="opacity-0 transition-opacity group-hover/ring:opacity-100"
          d={CHECK}
          fill="none"
          stroke={look.stroke}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export interface PriorityRingProps {
  priority: number;
  completed: boolean;
  size: PriorityRingSize;
  /** Makes the ring a real button that checks or unchecks the task. */
  onToggle?: () => void;
  /** -1 inside list rows: the row is the single tab stop (roving tabindex). */
  tabIndex?: number;
  disabled?: boolean;
  /** Plays the completion animation (list rows). */
  animate?: boolean;
}

/**
 * The checkbox. With `onToggle`, a <button> with a hit area larger than the drawing
 * (28 px for 20 px); without, a plain decorative drawing.
 */
export function PriorityRing({
  priority,
  completed,
  size,
  onToggle,
  tabIndex,
  disabled,
  animate = false,
}: PriorityRingProps) {
  if (!onToggle) {
    return (
      <PriorityRingSvg
        priority={priority}
        completed={completed}
        size={size}
        animate={animate}
      />
    );
  }
  const hit = size === 15 ? 20 : size + 8;
  const p = clampPriority(priority);
  return (
    <button
      type="button"
      data-priority-ring
      aria-label={priorityRingLabel(p, completed)}
      title={p > 1 ? t.priorityRing.name(displayPriority(p)) : undefined}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onToggle();
      }}
      className="group/ring touch-target relative -m-1 inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: hit, height: hit }}
    >
      <PriorityRingSvg
        priority={p}
        completed={completed}
        size={size}
        preview={!animate}
        animate={animate}
      />
    </button>
  );
}
