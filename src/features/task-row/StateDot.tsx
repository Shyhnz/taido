/**
 * Claude's state as a small coloured dot right of a task title ( like the project dot of the sidebar):
 * orange that breathes while Claude works or starts, red that pulses while it waits, green
 * once its turn is over, a black (white in dark mode) « ! » for an error, a dotted gray circle
 * for an open session that is ready. A task without a running Claude shows nothing.
 *
 * Shared by the lists, the task panel and its terminal tabs. Animations stop with « réduire
 * les animations » (stateDot.css).
 */

import type { Agent, Ring } from "../../bindings";
import { fr } from "../../i18n/fr";
import "./stateDot.css";

type DotLook = "working" | "waiting" | "done" | "error" | "idle";

/** Rings that draw a dot; the others (plain, completed, stopped session) draw nothing. */
const LOOK: Partial<Record<Ring, DotLook>> = {
  starting: "working",
  working: "working",
  waiting: "waiting",
  done: "done",
  error: "error",
  crashed: "error",
  idle: "idle",
};

/** True when `ring` shows a dot. */
export function hasStateDot(ring: Ring): boolean {
  return LOOK[ring] !== undefined;
}

/** « Claude travaille », « Codex attend ta réponse »… (the ring labels of fr.ts). */
export function stateDotLabel(ring: Ring, agent: Agent = "claude"): string {
  return fr.ring.state(ring, agent);
}

export interface StateDotProps {
  ring: Ring;
  /** The agent of the session the dot speaks of (its label names it). */
  agent?: Agent;
  /** Side of the drawing in px (default 12; the coloured disc is about 60 % of it). */
  size?: number;
}

export function StateDot({ ring, agent, size = 12 }: StateDotProps) {
  const look = LOOK[ring];
  if (!look) return null;
  const label = stateDotLabel(ring, agent);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state-dot={ring}
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="block overflow-visible"
      >
        {look === "working" && (
          <circle
            className="state-dot-breathe"
            cx="6"
            cy="6"
            r="3.6"
            fill="var(--state-working)"
          />
        )}
        {look === "waiting" && (
          <>
            <circle
              className="state-dot-halo"
              cx="6"
              cy="6"
              r="3.6"
              fill="var(--state-waiting)"
            />
            <circle
              className="state-dot-pulse"
              cx="6"
              cy="6"
              r="3.6"
              fill="var(--state-waiting)"
            />
          </>
        )}
        {look === "done" && (
          <circle cx="6" cy="6" r="3.6" fill="var(--state-done)" />
        )}
        {look === "error" && (
          <>
            <circle cx="6" cy="6" r="5.6" fill="var(--state-crashed)" />
            <path
              d="M6 3.1v3.5"
              stroke="var(--bg)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="6" cy="8.75" r="0.85" fill="var(--bg)" />
          </>
        )}
        {look === "idle" && (
          <circle
            cx="6"
            cy="6"
            r="3.9"
            fill="none"
            stroke="var(--state-idle)"
            strokeWidth="1.4"
            strokeDasharray="1.6 1.45"
          />
        )}
      </svg>
    </span>
  );
}
