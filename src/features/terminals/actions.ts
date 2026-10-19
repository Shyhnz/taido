/**
 * Terminal actions shared by the panel, the row menus and the keyboard: open (with the
 * folder flow), close, the guards before completing or deleting a
 * task, and quitting.
 */

import type {
  Agent,
  Editor,
  PermissionMode,
  TerminalInfo,
  TerminalKind,
} from "../../bindings";
import { confirmDialog, promptDialog } from "../../components/Dialog";
import { showError } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import { readableError, run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import {
  ensureAgentReady,
  resetClaudeCheck,
} from "../claude-check/claudeCheck";
import { focusTerminal, shownSize } from "./registry";
import { runningTerminals } from "./terminalList";

/** Size of a new terminal before it is shown and fitted. */
export const DEFAULT_SIZE = { cols: 120, rows: 32 };

export interface OpenOptions {
  /** Agent terminals: the tool to launch; absent = the default agent. */
  agent?: Agent;
  command?: string;
  initialPrompt?: string;
  permissionMode?: PermissionMode;
  addTaskContext?: boolean;
}

/** Asks for a folder and stores it at the right level. False when cancelled or failed. */
async function chooseFolder(taskId: string): Promise<boolean> {
  const path = await run(commands.pickFolder(fr.terminals.pickFolderTitle));
  if (!path) return false;
  const saved = await run(
    commands.setTaskFolder({ taskId, path }),
    fr.terminals.openError,
  );
  return saved !== undefined;
}

/**
 * Opens the task's working folder in the Finder, an editor (picked in « Ouvrir dans », then
 * remembered by the core as the last used) or Terminal.app. Without a folder, or when it is
 * gone, the user picks one first (stored at the right level, as for terminals).
 */
export async function openTaskFolderIn(
  taskId: string,
  app: "finder" | "editor" | "terminal",
  editor: Editor | null = null,
): Promise<void> {
  let task = await run(commands.getTask(taskId));
  if (!task) return;
  if (!task.workdir?.exists) {
    if (!(await chooseFolder(taskId))) return;
    task = await run(commands.getTask(taskId));
  }
  const path = task?.workdir?.path;
  if (!path) return;
  await run(
    commands.openPath({ path, with: app, editor }),
    fr.terminals.openInError,
  );
}

/**
 * Starts a terminal (`start` gets the size to open it at), shows it in the task's panel and
 * focuses it. Without a folder the user picks one (stored on the project, or on the task
 * without project); a missing folder offers « Choisir un dossier ». Returns `undefined` when
 * nothing was opened; other errors become a toast starting with `errorAction`.
 */
async function startInPanel(
  taskId: string,
  start: (size: { cols: number; rows: number }) => Promise<TerminalInfo>,
  errorAction: string,
): Promise<TerminalInfo | undefined> {
  const size = shownSize() ?? DEFAULT_SIZE;
  // Two folder questions at most: the first pick, then a pick of a folder gone meanwhile.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const info = await start(size);
      showTab(taskId, info.id);
      return info;
    } catch (error) {
      const kindOf = errorKind(error);
      if (kindOf === "no_folder") {
        if (!(await chooseFolder(taskId))) return undefined;
        continue;
      }
      if (kindOf === "folder_missing") {
        const task = await commands.getTask(taskId).catch(() => null);
        const ok = await confirmDialog({
          title: fr.terminals.folderMissingTitle,
          message: fr.terminals.folderMissingMessage(
            task?.workdir?.path ?? null,
          ),
          confirmLabel: fr.terminals.chooseFolder,
          danger: false,
        });
        if (!ok || !(await chooseFolder(taskId))) return undefined;
        continue;
      }
      // The binary went away since the check: the next launch checks again.
      if (kindOf === "claude_missing" || kindOf === "codex_missing") {
        resetClaudeCheck();
      }
      console.error(errorMessage(error), error);
      showError(readableError(error, errorAction));
      return undefined;
    }
  }
  return undefined;
}

/** Makes a tab of the task active (opening its panel if needed) and focuses its terminal. */
export function showTab(taskId: string, terminalId: string): void {
  const ui = useUi.getState();
  ui.setActiveTerminal(taskId, terminalId);
  if (ui.openTaskId !== taskId) ui.openTask(taskId);
  focusTerminal(terminalId);
}

/**
 * Focus mode's panes of a task (two to four), while shown: they handle ⌘⇧[ and ⌘⇧]
 * themselves.
 */
const paneCyclers = new Map<string, (step: 1 | -1) => void>();

/** Called by the panes of focus mode; returns the function that unregisters them. */
export function registerPaneCycler(
  taskId: string,
  cycle: (step: 1 | -1) => void,
): () => void {
  paneCyclers.set(taskId, cycle);
  return () => {
    if (paneCyclers.get(taskId) === cycle) paneCyclers.delete(taskId);
  };
}

/**
 * ⌘⇧[ and ⌘⇧]: shows the previous or next terminal tab of the task, wrapping
 * around. The active tab is the remembered one, else the last (as the panel shows it). In
 * focus mode with two panes or more there are no tabs: the panes move instead (`cyclePanes`).
 */
export async function cycleTerminal(
  taskId: string,
  step: 1 | -1,
): Promise<void> {
  const panes = paneCyclers.get(taskId);
  if (panes) {
    panes(step);
    return;
  }
  const task = await run(commands.getTask(taskId));
  const terminals = task?.terminals ?? [];
  if (terminals.length < 2) return;
  const remembered = useUi.getState().activeTerminals[taskId];
  const found = terminals.findIndex((t) => t.id === remembered);
  const current = found === -1 ? terminals.length - 1 : found;
  const next =
    terminals[(current + step + terminals.length) % terminals.length];
  showTab(taskId, next.id);
}

/**
 * Opens a terminal on a task, shows it in the task's panel and focuses it (folder flow). Returns `undefined` when nothing was opened.
 */
export function openTerminal(
  taskId: string,
  kind: TerminalKind,
  options: OpenOptions = {},
): Promise<TerminalInfo | undefined> {
  return startInPanel(
    taskId,
    (size) =>
      commands.openTerminal({
        taskId,
        kind,
        agent: options.agent ?? null,
        command: options.command ?? null,
        initialPrompt: options.initialPrompt ?? null,
        permissionMode: options.permissionMode ?? null,
        addTaskContext: options.addTaskContext ?? null,
        cols: size.cols,
        rows: size.rows,
      }),
    fr.terminals.openError,
  );
}

/**
 * « Reprendre »: the conversation comes back in a new tab of its task, like
 * `claude --resume`, with the same folder flow as a new terminal.
 */
export async function resumeSession(
  taskId: string,
  agentSessionId: string,
  agent: Agent = "claude",
): Promise<TerminalInfo | undefined> {
  // A second click while the first resume launches would start a second Claude on the same
  // conversation (the core refuses it too).
  if (resuming.has(agentSessionId)) return undefined;
  resuming.add(agentSessionId);
  try {
    if (!(await ensureAgentReady(agent))) return undefined;
    return await startInPanel(
      taskId,
      (size) =>
        commands.resumeSession({
          agentSessionId,
          cols: size.cols,
          rows: size.rows,
        }),
      fr.sessions.resumeError,
    );
  } finally {
    resuming.delete(agentSessionId);
  }
}

/** Sessions whose resume is being launched. */
const resuming = new Set<string>();

/** « Lancer une commande… »: asks for the command line, then opens it. */
export async function promptCommand(taskId: string): Promise<void> {
  const values = await promptDialog({
    title: fr.terminals.commandTitle,
    fields: [
      {
        name: "command",
        label: fr.terminals.commandLabel,
        placeholder: fr.terminals.commandPlaceholder,
        mono: true,
        required: true,
      },
    ],
    confirmLabel: fr.terminals.launch,
  });
  const command = values?.command?.trim();
  if (command) await openTerminal(taskId, "command", { command });
}

/**
 * « Lancer Claude Code » / « Lancer Codex »: one click, a new conversation in a new tab, with
 * `agent` or else the default agent (Réglages › Agents). The first Claude launch of the app
 * run checks Claude Code first.
 */
export async function launchAgent(
  taskId: string,
  agent?: Agent,
): Promise<TerminalInfo | undefined> {
  // Settings unreadable: no check, and the core launches its own default (never a guess).
  const chosen = agent ?? (await run(commands.getSettings()))?.defaultAgent;
  if (chosen && !(await ensureAgentReady(chosen))) return undefined;
  // Taido V2.3: a blocked task warns first, without forbidding.
  const task = await run(commands.getTask(taskId));
  const blockers = task?.relations.blockedBy.filter((t) => !t.completed) ?? [];
  if (blockers.length > 0) {
    const ok = await confirmDialog({
      title: fr.relations.warnTitle,
      message: fr.relations.warnMessage(
        blockers.map((t) => `« ${t.title} »`).join(", "),
        chosen ?? "claude",
      ),
      confirmLabel: fr.relations.warnConfirm,
      danger: false,
    });
    if (!ok) return undefined;
  }
  // One click, no dialog, no first message: the user talks to Claude; Claude only knows,
  // silently, which task it is on (context file). By design.
  return openTerminal(taskId, "agent", { agent: chosen, addTaskContext: true });
}

/**
 * Closes a terminal tab. A running Claude terminal always asks first (its
 * state is not known); a shell, a command or an exited terminal closes at once.
 */
export async function closeTerminal(info: TerminalInfo): Promise<boolean> {
  if (info.running && info.kind === "agent") {
    const ok = await confirmDialog({
      title: fr.terminals.closeClaudeTitle(info.agent ?? "claude"),
      message: fr.terminals.closeClaudeMessage(info.agent ?? "claude"),
      confirmLabel: fr.terminals.closeClaudeConfirm,
    });
    if (!ok) return false;
  }
  const done = await run(
    commands.closeTerminal(info.id),
    fr.errors.action.closeTerminal,
  );
  return done !== undefined;
}

/**
 * Running Claude terminals that completing or deleting `taskId` stops: its own and, for a
 * parent, its subtasks'. The subtasks are
 * asked of the core only when a Claude runs in another task.
 */
export async function sessionsStoppedWith(
  taskId: string,
): Promise<TerminalInfo[]> {
  const claude = runningTerminals().filter((t) => t.kind === "agent");
  if (claude.every((t) => t.taskId === taskId)) return claude;
  const ids = new Set([taskId]);
  try {
    const task = await commands.getTask(taskId);
    for (const subtask of task.subtasks) ids.add(subtask.id);
  } catch {
    // The task is gone: only its own terminals count.
  }
  return claude.filter((t) => ids.has(t.taskId));
}

/**
 * Before completing or deleting a task: the core closes its terminals and its subtasks', so
 * a running Claude session asks for confirmation. True when the action may go on.
 */
export async function confirmStopSessions(
  taskId: string,
  action: "complete" | "delete",
): Promise<boolean> {
  const sessions = await sessionsStoppedWith(taskId);
  if (sessions.length === 0) return true;
  return confirmDialog({
    title: fr.terminals.stopSessionsTitle(sessions.length),
    message:
      action === "complete"
        ? fr.terminals.completeMessage
        : fr.terminals.deleteMessage,
    confirmLabel:
      action === "complete"
        ? fr.terminals.completeConfirm
        : fr.terminals.deleteConfirm,
  });
}

/**
 * ⌘Q: running Claude sessions are paused, other running terminals stopped; both
 * ask first. Nothing running quits at once.
 */
export async function requestQuit(): Promise<void> {
  const running = runningTerminals();
  const sessions = running.filter((t) => t.kind === "agent").length;
  const others = running.length - sessions;
  if (running.length > 0) {
    const ok = await confirmDialog({
      title: fr.terminals.quitTitle,
      message:
        sessions > 0
          ? fr.terminals.quitSessions(sessions)
          : fr.terminals.quitTerminals(others),
      confirmLabel: fr.terminals.quitConfirm,
    });
    if (!ok) return;
  }
  await run(commands.quitApp());
}
