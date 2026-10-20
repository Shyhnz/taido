/**
 * Who gets a key pressed in a terminal. On macOS, ⌘ keys belong to the app (⌘T, ⌘1…) and ⌘C
 * copies a selection, while Ctrl keys stay the terminal's (Ctrl+C interrupts). Windows has no
 * ⌘: as in Windows Terminal, Ctrl+C copies a selection (and interrupts without one), Ctrl+V
 * pastes, and only the app's own Ctrl shortcuts leave the terminal; the shell keeps Ctrl+K,
 * Ctrl+N, Ctrl+R… (readline, PSReadLine).
 */

import type { Os } from "../../lib/platform";

/** `copy`: copy the selection; `paste`: let the browser paste; `app`: the app's shortcut. */
export type TerminalKeyAction = "copy" | "paste" | "app" | "terminal";

/** Ctrl shortcuts of the app (useShortcuts) that leave a terminal on Windows. */
function isAppShortcut(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  if (/^Digit[1-3]$/.test(e.code) || /^[1-3]$/.test(key)) return true;
  if (key === "," || key === "t") return true;
  if (!e.shiftKey) return false;
  return (
    key === "f" ||
    e.code === "BracketLeft" ||
    e.code === "BracketRight" ||
    ["[", "]", "{", "}"].includes(key)
  );
}

export function terminalKey(
  e: KeyboardEvent,
  os: Os,
  hasSelection: boolean,
): TerminalKeyAction {
  const key = e.key.toLowerCase();
  // Windows only: elsewhere (macOS, and as before on other systems) ⌘ keys are the app's.
  if (os !== "windows") {
    if (!e.metaKey) return "terminal";
    return key === "c" && hasSelection ? "copy" : "app";
  }
  if (!e.ctrlKey || e.altKey || e.metaKey) return "terminal";
  if (key === "c") return hasSelection ? "copy" : "terminal";
  if (key === "v") return "paste";
  return isAppShortcut(e) ? "app" : "terminal";
}
