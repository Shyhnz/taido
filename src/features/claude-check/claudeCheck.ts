/**
 * Claude Code check: before the first Claude terminal of the app
 * run, `check_claude` tells whether the binary is found and logged in. A success is kept for
 * the whole run; a problem opens a dialog (« Réessayer », « Ouvrir les réglages ») and the
 * launch waits for it.
 *
 * A check that fails by itself (the command rejects) does not block: the launch goes on and
 * reports `claude_missing` on its own if needed. It is not remembered, so the next launch
 * checks again.
 */

import type { Agent, AgentStatus } from "../../bindings";
import { commands, errorMessage } from "../../lib/ipc";
import { type ClaudeProblem, useUi } from "../../stores/ui";

/** Agents a check found ready during this app run. */
const verified = new Set<Agent>();
/** The gate in progress, per agent: two quick launches share one check and one dialog. */
const pending = new Map<Agent, Promise<boolean>>();
/** Resolves the gate waiting on the dialog. */
let settle: ((ok: boolean) => void) | null = null;

/** What prevents launching Claude Code, `null` when nothing does. */
export function claudeProblem(status: AgentStatus): ClaudeProblem | null {
  if (!status.path) return "missing";
  // `null`: `claude auth status` could not be read; Claude's own screen will tell.
  if (status.loggedIn === false) return "notLoggedIn";
  return null;
}

/** Runs `check_agent` and remembers the outcome for the next launches. Rejects on failure. */
export async function checkAgentStatus(agent: Agent): Promise<AgentStatus> {
  const status = await commands.checkAgent(agent);
  if (claudeProblem(status) === null) verified.add(agent);
  else verified.delete(agent);
  return status;
}

/**
 * Before launching Claude Code: true when the launch may go on. The first call of the app run
 * checks; the user may then fix the problem from the dialog and retry.
 */
export function ensureAgentReady(agent: Agent): Promise<boolean> {
  if (verified.has(agent)) return Promise.resolve(true);
  let gateOf = pending.get(agent);
  if (!gateOf) {
    gateOf = gate(agent).finally(() => {
      pending.delete(agent);
    });
    pending.set(agent, gateOf);
  }
  return gateOf;
}

async function gate(agent: Agent): Promise<boolean> {
  let status: AgentStatus;
  try {
    status = await checkAgentStatus(agent);
  } catch (error) {
    console.error(errorMessage(error), error);
    return true;
  }
  const problem = claudeProblem(status);
  if (problem === null) return true;
  return askUser(problem, agent);
}

/** Opens the dialog and waits: true after a successful « Réessayer ». */
function askUser(problem: ClaudeProblem, agent: Agent): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let unsubscribe = () => {};
    const finish = (ok: boolean) => {
      if (settle !== finish) return;
      settle = null;
      unsubscribe();
      resolve(ok);
    };
    settle = finish;
    // Any other way the dialog goes away (Échap, « Ouvrir les réglages », another dialog)
    // cancels the launch.
    unsubscribe = useUi.subscribe((s) => {
      if (s.dialog?.type !== "claudeCheck") finish(false);
    });
    useUi.getState().openDialog({ type: "claudeCheck", problem, agent });
  });
}

/** « Réessayer » succeeded: the waiting launch goes on. */
export function resolveClaudeCheck(ok: boolean): void {
  settle?.(ok);
}

/** Forgets the outcome (tests, or after the user changes the path of the binary). */
export function resetClaudeCheck(): void {
  verified.clear();
  pending.clear();
  settle?.(false);
}
