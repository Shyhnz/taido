/**
 * The few words that depend on the computer's system: the file manager (Finder on macOS,
 * Explorer on Windows) and the shortcut keys (⌘ on macOS, Ctrl on Windows). The string
 * tables are written with the macOS words; `forPlatform` rewrites them for Windows, in both
 * languages, so a component never has to know the system. Keys typed in components go through
 * `keys`.
 *
 * Only Windows changes the words: any other user agent (macOS, the tests' jsdom, the phone)
 * keeps the tables as written. `other` (not Apple, not Windows) matters for the keys only:
 * Ctrl acts as ⌘ there (`useShortcuts`).
 */

import type { Language } from "../i18n";

export type Os = "mac" | "windows" | "other";

/** From the WebView's user agent: WebView2 says « Windows NT », Apple's « Mac » or « iPhone ». */
export function detectOs(userAgent: string | undefined): Os {
  if (!userAgent) return "other";
  if (/Windows/.test(userAgent)) return "windows";
  return /Mac|iPhone|iPad/.test(userAgent) ? "mac" : "other";
}

/** The system of this window. */
export const OS: Os = detectOs(
  typeof navigator === "undefined" ? undefined : navigator.userAgent,
);

const WINDOWS_KEYS: Record<string, string> = {
  "⌘": "Ctrl+",
  "⌃": "Ctrl+",
  "⇧": "Shift+",
  "⌥": "Alt+",
};

/** « ⌘⇧N » as `os` writes it: unchanged on macOS, « Ctrl+Shift+N » on Windows. */
export function keysFor(label: string, os: Os): string {
  if (os !== "windows") return label;
  return label.replace(/[⌘⌃⇧⌥]/g, (glyph) => WINDOWS_KEYS[glyph] ?? glyph);
}

/** A shortcut label for this computer. */
export function keys(label: string): string {
  return keysFor(label, OS);
}

/** The npm folder of a Windows user, for the example path of an agent's program. */
const WINDOWS_EXAMPLE_DIR = "C:\\Users\\you\\AppData\\Roaming\\npm\\";

/** A text of the tables as `os` words it (file manager, keys, example path). */
export function textFor(text: string, os: Os, lang: Language): string {
  if (os !== "windows") return text;
  let out = keysFor(text, os).replace(
    /\/opt\/homebrew\/bin\/(\w+)/g,
    (_, name: string) => `${WINDOWS_EXAMPLE_DIR}${name}.cmd`,
  );
  out =
    lang === "fr"
      ? out
          .replace(/\bdu Finder\b/g, "de l'Explorateur")
          .replace(/\ble Finder\b/g, "l'Explorateur")
          .replace(/\bFinder\b/g, "Explorateur")
      : out.replace(/\bFinder\b/g, "Explorer");
  return out;
}

type Fn = (...args: never[]) => unknown;

/**
 * `table` with every text, and every text a function of it returns, worded for `os`. The
 * table itself on macOS.
 */
export function forPlatform<T>(table: T, os: Os, lang: Language): T {
  if (os !== "windows") return table;
  const convert = (value: unknown): unknown => {
    if (typeof value === "string") return textFor(value, os, lang);
    if (typeof value === "function") {
      const fn = value as Fn;
      return (...args: never[]) => convert(fn(...args));
    }
    if (Array.isArray(value)) return value.map(convert);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, convert(v)]),
      );
    }
    return value;
  };
  return convert(table) as T;
}
