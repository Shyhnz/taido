/**
 * Labels of a task's terminals (redesign option A, 2026-10-04): two Claude terminals
 * side by side must not both read « Claude Code ». With two Claude terminals or more, each
 * takes the recap of its conversation (« Claude · refonte panneau »), else a number
 * (« Claude Code 2 ») until its first message. Same label in tabs, pane headers and menus.
 */

import type { SessionSummary, TaskDetail, TerminalInfo } from "../../bindings";
import { t as strings } from "../../i18n";
import { useTaskSessions } from "../../lib/queries";
import { terminalLabel } from "./terminalList";

/** Characters kept of a recap in a tab. */
const RECAP_MAX = 28;

function shortRecap(summary: SessionSummary | undefined): string | null {
  const text = summary?.title ?? summary?.aiSummary ?? summary?.firstPrompt;
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > RECAP_MAX
    ? `${line.slice(0, RECAP_MAX - 1).trimEnd()}…`
    : line;
}

/** Label of each terminal of the task, by terminal id. */
export function terminalLabels(
  terminals: TerminalInfo[],
  sessions: SessionSummary[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const claudes = terminals.filter((t) => t.kind === "agent");
  let n = 0;
  for (const t of terminals) {
    if (t.kind !== "agent" || claudes.length < 2) {
      labels.set(t.id, terminalLabel(t));
      continue;
    }
    n += 1;
    const recap = shortRecap(sessions.find((s) => s.id === t.agentSessionId));
    labels.set(
      t.id,
      recap
        ? strings.terminals.claudeNamed(recap, t.agent ?? "claude")
        : n === 1
          ? strings.terminals.agent(t.agent ?? "claude")
          : strings.terminals.claudeNumbered(n, t.agent ?? "claude"),
    );
  }
  return labels;
}

export function useTerminalLabels(task: TaskDetail): Map<string, string> {
  const { data = [] } = useTaskSessions(task.id);
  return terminalLabels(task.terminals, data);
}
