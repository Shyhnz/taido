/**
 * Terminals kept by the core, all tasks together, mirrored from the `terminals` query by
 * <TerminalsHost />. Read outside React by the guards (complete, delete, quit).
 */

import { create } from "zustand";
import type { TerminalInfo } from "../../bindings";
import { t as strings } from "../../i18n";

export const useTerminalList = create<{ list: TerminalInfo[] }>(() => ({
  list: [],
}));

export function setTerminalList(list: TerminalInfo[]): void {
  useTerminalList.setState({ list });
}

/** Running terminals, optionally of one task. */
export function runningTerminals(taskId?: string): TerminalInfo[] {
  return useTerminalList
    .getState()
    .list.filter((t) => t.running && (!taskId || t.taskId === taskId));
}

/** Tab label: « Claude Code », « Codex », « Shell », or the command line. */
export function terminalLabel(
  t: Pick<TerminalInfo, "kind" | "command"> &
    Partial<Pick<TerminalInfo, "agent">>,
) {
  if (t.kind === "agent") return strings.terminals.agent(t.agent ?? "claude");
  if (t.kind === "shell") return strings.terminals.shell;
  return t.command?.trim() || strings.terminals.shell;
}
