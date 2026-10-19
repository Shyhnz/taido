import type { Agent } from "../../bindings";
import { t as strings, tutorialTexts } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import type { StepId } from "./model";

/** The guide's texts for the default agent (chosen on the first card). */
export function useTutorialTexts(): typeof strings.tutorial {
  return tutorialTexts(useDefaultAgent());
}

/** Title of a step, as its bubble or card shows it. */
export function stepTitle(step: StepId, agent: Agent = "claude"): string {
  const t = tutorialTexts(agent);
  switch (step) {
    case "welcome":
      return t.welcome.title(strings.appName);
    case "project":
      return t.project.title;
    case "task":
      return t.task.title;
    case "open":
      return t.open.title;
    case "claude":
      return t.claude.title;
    case "talk":
      return t.talk.title;
    case "kanban":
      return t.kanban.title;
    case "file":
      return t.file.title;
    case "quickAdd":
      return t.quickAdd.title;
    case "complete":
      return t.complete.title;
    case "account":
      return t.account.title;
    case "done":
      return t.done.title;
  }
}
