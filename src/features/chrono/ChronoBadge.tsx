/**
 * The chrono on a task row or a kanban card: `1:15:32 ▶` while it runs,
 * `1:15:32 ‖` when paused. Absent until the task has time.
 */

import type { TaskChrono } from "../../bindings";
import { t } from "../../i18n";
import { chronoSeconds, formatChrono, useNow } from "./chrono";

export function ChronoBadge({ chrono }: { chrono: TaskChrono }) {
  const running = chrono.runningSince !== null;
  const now = useNow(running);
  const time = formatChrono(chronoSeconds(chrono, now));
  const label = running
    ? t.chrono.runningLabel(time)
    : t.chrono.pausedLabel(time);
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${running ? "text-text" : ""}`}
      title={label}
      data-chrono={running ? "running" : "paused"}
    >
      <span aria-hidden="true">{time}</span>
      <span
        aria-hidden="true"
        className={running ? "text-accent" : "text-text-3"}
      >
        {running ? "▶" : "‖"}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
