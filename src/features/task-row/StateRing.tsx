/**
 * The round checkbox of a task: exact SVG geometry, one look per ring.
 * Colors go through CSS variables whose light values are the spec's hex codes.
 */

import type { MouseEvent } from "react";
import type { Agent, Ring } from "../../bindings";
import { fr } from "../../i18n/fr";

export type RingSize = 20 | 24 | 15;

interface Look {
  fill: string;
  stroke: string;
  dash?: string;
  arc?: boolean;
  /** Center dot: red and pulsing while Claude waits, green and still when its turn ended. */
  dot?: { color: string; pulse: boolean };
  check?: string;
  bang?: boolean;
}

const LOOKS: Record<Ring, Look> = {
  human: { fill: "none", stroke: "var(--state-idle)" },
  starting: { fill: "none", stroke: "var(--state-working-track)", arc: true },
  working: { fill: "none", stroke: "var(--state-working-track)", arc: true },
  waiting: {
    fill: "var(--state-waiting-fill)",
    stroke: "var(--state-waiting)",
    dot: { color: "var(--state-waiting)", pulse: true },
  },
  // Claude finished its turn: a green dot, never a check (only the user completes a task,).
  done: {
    fill: "var(--bar-done)",
    stroke: "var(--state-done)",
    dot: { color: "var(--state-done)", pulse: false },
  },
  idle: { fill: "none", stroke: "var(--state-idle)", dash: "2 2.6" },
  paused: { fill: "none", stroke: "var(--state-idle)", dash: "2 2.6" },
  error: { fill: "none", stroke: "var(--state-crashed)", bang: true },
  crashed: { fill: "none", stroke: "var(--state-crashed)", bang: true },
  completed: {
    fill: "var(--state-completed)",
    stroke: "var(--state-completed)",
    check: "var(--ring-check-on-fill)",
  },
};

/** Rings that show a hover preview of the check mark (like Todoist). */
const PREVIEW: ReadonlySet<Ring> = new Set(["human", "idle", "paused"]);

export function ringLabel(ring: Ring, agent: Agent = "claude"): string {
  return fr.ring.state(ring, agent);
}

export function ringAriaLabel(ring: Ring, agent: Agent = "claude"): string {
  if (ring === "completed") return fr.ring.reopen;
  // A plain task just says « Terminer »; an agent state is added to the name.
  return fr.ring.markDone(ring === "human" ? null : ringLabel(ring, agent));
}

export function RingSvg({
  ring,
  size,
  preview = false,
  animate = false,
}: {
  ring: Ring;
  size: RingSize;
  /** Adds the hover check preview (shown by the parent's `group` hover). */
  preview?: boolean;
  /** Completion animation: the circle fills and the check draws itself. */
  animate?: boolean;
}) {
  const look = LOOKS[ring];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-ring={ring}
      data-animate={animate || undefined}
      className={`block shrink-0 overflow-visible ${animate ? "ring-complete" : ""}`}
    >
      <circle
        data-part="base"
        cx="10"
        cy="10"
        r="8.4"
        fill={look.fill}
        stroke={look.stroke}
        strokeWidth="1.6"
        strokeDasharray={look.dash}
      />
      {look.arc && (
        <g className="ring-spin" data-part="arc">
          <circle
            cx="10"
            cy="10"
            r="8.4"
            fill="none"
            stroke="var(--state-working)"
            strokeWidth="1.9"
            strokeDasharray="16 40"
            strokeLinecap="round"
            transform="rotate(-90 10 10)"
          />
        </g>
      )}
      {look.dot && (
        <circle
          data-part="dot"
          className={look.dot.pulse ? "ring-pulse" : undefined}
          cx="10"
          cy="10"
          r="3.4"
          fill={look.dot.color}
        />
      )}
      {look.check && (
        <path
          data-part="check"
          pathLength={1}
          d="M6.3 10.3l2.5 2.4 5-5.2"
          fill="none"
          stroke={look.check}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {look.bang && (
        <g data-part="bang">
          <path
            d="M10 5.8v4.6"
            stroke="var(--state-crashed)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="10" cy="13.7" r="1.05" fill="var(--state-crashed)" />
        </g>
      )}
      {preview && PREVIEW.has(ring) && (
        <path
          data-part="preview"
          className="opacity-0 transition-opacity group-hover/ring:opacity-100"
          d="M6.3 10.3l2.5 2.4 5-5.2"
          fill="none"
          stroke="var(--state-idle)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export interface StateRingProps {
  ring: Ring;
  /** The agent of the session the ring speaks of (its label names it). */
  agent?: Agent;
  size?: RingSize;
  onToggle?: () => void;
  disabled?: boolean;
  /** -1 inside list rows: the row is the single tab stop (roving tabindex). */
  tabIndex?: number;
  /** Plays the completion animation (list rows). */
  animate?: boolean;
}

/** Interactive ring: a real <button> toggling completion (28 px hit area for 20 px). */
export function StateRing({
  ring,
  agent,
  size = 20,
  onToggle,
  disabled,
  tabIndex,
  animate = false,
}: StateRingProps) {
  const hit = size === 15 ? 20 : size + 8;
  return (
    <button
      type="button"
      aria-label={ringAriaLabel(ring, agent)}
      title={ringLabel(ring, agent)}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onToggle?.();
      }}
      className="group/ring -m-1 inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: hit, height: hit }}
    >
      <RingSvg ring={ring} size={size} preview={!animate} animate={animate} />
    </button>
  );
}
