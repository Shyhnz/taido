/**
 * The English table. Temporary (step 3, task 1): the French table with the language select and
 * the date words in English, so that the wiring is testable. Task 2 translates the rest.
 */

import {
  agentErrorLabel,
  agentInstallCommand,
  agentLoginCommand,
  agentName,
  agentProduct,
  fr,
  tutorialTexts,
} from "./fr";
import type { Strings } from "./index";

export const en: Strings = {
  ...fr,
  settings: {
    ...fr.settings,
    language: "Language / Langue",
    languageHelp: "Taido restarts to change the language.",
  },
  dates: {
    justNow: "just now",
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    yesterdayAt: (time: string) => `yesterday ${time}`,
    todayAt: (time: string) => `today ${time}`,
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
  },
};

/** Per-language helpers that `fr.ts` exports next to its table (still French here). */
export const enHelpers = {
  agentName,
  agentProduct,
  agentInstallCommand,
  agentLoginCommand,
  agentErrorLabel,
  tutorialTexts,
};
