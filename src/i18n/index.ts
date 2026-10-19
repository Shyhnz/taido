/**
 * The active UI language. English by default, French as an option (Settings › General).
 *
 * The choice is mirrored in `localStorage["taido.language"]` (read synchronously at startup,
 * on the desktop and on the phone) and kept in the core's settings. With nothing stored, the
 * system language decides: `fr…` gives French, anything else English. Changing the language
 * saves both and reloads the window, so `t` is a plain constant, no React context.
 */

import type { Settings } from "../bindings";
import { settingsPatch } from "../lib/settingsPatch";
import { en, enHelpers } from "./en";
import { type Fr, fr, frHelpers } from "./fr";

export type Language = "en" | "fr";
/** `fr` is `as const`; the table type widens the literals so that `en` can have its own texts. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: Widen<T[K]> }
        : T;
export type Strings = Widen<Fr>;

export const LANGUAGE_KEY = "taido.language";

const isLanguage = (value: unknown): value is Language =>
  value === "en" || value === "fr";

/** `fr`, `fr-FR`… give French; anything else (or nothing) English. */
export function detectLanguage(nav: string | undefined): Language {
  return nav?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function stored(): Language | null {
  try {
    const value = window.localStorage.getItem(LANGUAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function remember(lang: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // No storage (private window): the choice then only lives in the core.
  }
}

/** The stored choice; at first launch the detected one, which is stored. */
export function currentLanguage(): Language {
  const chosen = stored();
  if (chosen) return chosen;
  const detected = detectLanguage(
    typeof navigator === "undefined" ? undefined : navigator.language,
  );
  remember(detected);
  return detected;
}

const language = currentLanguage();

/** The active string table. */
export const t: Strings = language === "fr" ? fr : en;

const helpers = language === "fr" ? frHelpers : enHelpers;

export const {
  agentName,
  agentProduct,
  agentInstallCommand,
  agentLoginCommand,
  agentErrorLabel,
  tutorialTexts,
} = helpers;

/** Saves the choice here and in the core, then reloads so every text is rebuilt. */
export async function setLanguage(lang: Language): Promise<void> {
  remember(lang);
  // Loaded on demand: `ipc` reaches the date helpers, which import this module.
  const { commands } = await import("../lib/ipc");
  await commands.updateSettings(settingsPatch({ language: lang }));
  globalThis.location.reload();
}

/**
 * Brings the core and this window to the same language at startup. The core has none yet (a
 * first launch): it gets ours. The core has another (a restored or synced install): we adopt
 * it and reload once.
 */
export async function reconcileLanguage(settings: Settings): Promise<void> {
  const local = currentLanguage();
  if (settings.language === local) return;
  if (settings.language) {
    remember(settings.language);
    globalThis.location.reload();
    return;
  }
  const { commands } = await import("../lib/ipc");
  await commands.updateSettings(settingsPatch({ language: local }));
}
