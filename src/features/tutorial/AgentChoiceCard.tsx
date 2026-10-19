/**
 * « Avec quelle IA tu travailles ? »: the first card of a
 * first launch, before the welcome. Each AI shows what the check found; a ready one is chosen
 * already, a missing one gives its command. Never blocking: « Continuer » always works, and
 * the launch itself says what is missing.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Agent, AgentStatus, Settings } from "../../bindings";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import {
  agentInstallCommand,
  agentLoginCommand,
  agentProduct,
  fr,
} from "../../i18n/fr";
import { commands } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { run } from "../../lib/run";
import { settingsPatch } from "../../lib/settingsPatch";
import { checkAgentStatus, claudeProblem } from "../claude-check/claudeCheck";
import { PromptBox } from "./PromptBox";

const AGENTS: readonly Agent[] = ["claude", "codex"];

function useStatus(agent: Agent) {
  return useQuery({
    queryKey: queryKeys.agentStatus(agent),
    queryFn: () => checkAgentStatus(agent),
    staleTime: 0,
    retry: false,
  });
}

function statusLine(status: AgentStatus | undefined, failed: boolean): string {
  if (failed) return fr.tutorial.agent.checkFailed;
  if (!status) return fr.settings.agentCheckingShort;
  if (!status.path) return fr.settings.agentMissingShort;
  if (status.loggedIn === false) return fr.settings.agentLoggedOutShort;
  return fr.settings.agentReady(status.version);
}

export function AgentChoiceCard() {
  const t = fr.tutorial.agent;
  const client = useQueryClient();
  const claude = useStatus("claude");
  const codex = useStatus("codex");
  const statuses = { claude, codex };
  const [picked, setPicked] = useState<Agent | null>(null);
  const [saving, setSaving] = useState(false);

  const ready = (agent: Agent) => {
    const s = statuses[agent].data;
    return s !== undefined && claudeProblem(s) === null;
  };
  // Until the user picks: the ready one (Claude Code when both are), else Claude Code.
  const suggested: Agent =
    ready("claude") || !ready("codex") ? "claude" : "codex";
  const chosen = picked ?? suggested;
  const checking = claude.isFetching || codex.isFetching;

  const finish = async (agent: Agent) => {
    setSaving(true);
    const next = await run(
      commands.updateSettings(
        settingsPatch({ defaultAgent: agent, agentChosen: true }),
      ),
      fr.errors.action.settings,
    );
    setSaving(false);
    if (next) client.setQueryData<Settings>(queryKeys.settings, next);
  };

  return (
    <Dialog title={t.title} onClose={() => void finish("claude")} width={480}>
      <div className="px-5 pt-1 pb-5">
        <p className="text-body text-text-2">{t.text}</p>
        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="sr-only">{t.choices}</legend>
          {AGENTS.map((agent) => (
            <AgentOption
              key={agent}
              agent={agent}
              checked={chosen === agent}
              onPick={() => setPicked(agent)}
              status={statuses[agent].data}
              failed={statuses[agent].isError}
            />
          ))}
        </fieldset>
        <div className="mt-5 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={checking}
            onClick={() => {
              void claude.refetch();
              void codex.refetch();
            }}
          >
            {t.checkAgain}
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => void finish("claude")}
          >
            {t.later}
          </Button>
          <Button
            variant="primary"
            data-autofocus
            disabled={saving}
            onClick={() => void finish(chosen)}
          >
            {t.next}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AgentOption({
  agent,
  checked,
  onPick,
  status,
  failed,
}: {
  agent: Agent;
  checked: boolean;
  onPick: () => void;
  status: AgentStatus | undefined;
  failed: boolean;
}) {
  const problem = status ? claudeProblem(status) : null;
  return (
    <label className="flex cursor-pointer flex-col rounded-md border border-border px-3 py-2.5 has-[:checked]:border-accent has-[:checked]:bg-aside has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]">
      <span className="flex items-center gap-2.5">
        <input
          type="radio"
          name="first-agent"
          value={agent}
          checked={checked}
          onChange={onPick}
          className="accent-[var(--accent)]"
        />
        <span className="text-[13.5px] font-medium">{agentProduct(agent)}</span>
        <span className="ml-auto text-[12px] text-text-2">
          {statusLine(status, failed)}
        </span>
      </span>
      {problem === "missing" && <PromptBox text={agentInstallCommand(agent)} />}
      {problem === "notLoggedIn" && (
        <PromptBox text={agentLoginCommand(agent)} />
      )}
    </label>
  );
}
