/**
 * « Claude Code introuvable » / « Claude Code n'est pas connecté »: shown by the
 * check before the first Claude terminal. « Réessayer » checks again and, once Claude Code is
 * ready, lets the launch go on; « Ouvrir les réglages » opens the Claude Code tab instead.
 */

import { useState } from "react";
import type { Agent, AgentStatus } from "../../bindings";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { t as strings } from "../../i18n";
import { errorMessage } from "../../lib/ipc";
import { OS } from "../../lib/platform";
import { type ClaudeProblem, useUi } from "../../stores/ui";
import {
  checkAgentStatus,
  claudeProblem,
  resolveClaudeCheck,
} from "./claudeCheck";

export function ClaudeCheckDialog({
  problem: initial,
  agent,
  onClose,
}: {
  problem: ClaudeProblem;
  agent: Agent;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState(initial);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set after a « Réessayer » that found the same or another problem. */
  const [retried, setRetried] = useState(false);
  const t = strings.claudeCheck;

  const retry = async () => {
    setBusy(true);
    let next: AgentStatus | null = null;
    try {
      next = await checkAgentStatus(agent);
    } catch (error) {
      console.error(errorMessage(error), error);
    }
    setBusy(false);
    // The dialog went away during the check (« Ouvrir les réglages », Échap): its launch is
    // cancelled, and closing now would close whatever window is open instead.
    if (useUi.getState().dialog?.type !== "claudeCheck") return;
    // A check that fails by itself does not block the launch (see claudeCheck.ts).
    const found = next ? claudeProblem(next) : null;
    if (found === null) {
      resolveClaudeCheck(true);
      onClose();
      return;
    }
    setStatus(next);
    setProblem(found);
    setRetried(true);
  };

  const openSettings = () => {
    useUi.getState().openDialog({ type: "settings", tab: "agents" });
  };

  const missing = problem === "missing";
  const detail =
    !missing && status ? t.found(status.version, status.path) : null;

  return (
    <Dialog
      title={missing ? t.missingTitle(agent) : t.loggedOutTitle(agent)}
      onClose={onClose}
      width={460}
    >
      <div className="flex flex-col gap-2 px-5 pt-2 text-[13.5px] text-text-2">
        <p>{missing ? t.missingText(agent) : t.loggedOutText(agent)}</p>
        {missing && <p>{t.missingSettings}</p>}
        {missing && OS === "windows" && <p>{t.missingNode}</p>}
        {detail && (
          <p className="font-mono text-[12px] break-all text-text-3">
            {detail}
          </p>
        )}
        <p role="status" className="min-h-[18px] text-[12.5px] text-text">
          {busy
            ? t.checking
            : retried
              ? missing
                ? t.stillMissing
                : t.stillLoggedOut
              : ""}
        </p>
      </div>
      <div className="flex justify-end gap-2 px-5 pt-2 pb-4">
        <Button onClick={openSettings}>{t.openSettings}</Button>
        <Button
          variant="primary"
          onClick={() => void retry()}
          disabled={busy}
          data-autofocus
        >
          {t.retry}
        </Button>
      </div>
    </Dialog>
  );
}
