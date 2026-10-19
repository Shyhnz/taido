/**
 * Stand-in for src/features/terminals/xterm.ts in the mobile build (vite.mobile.config.ts):
 * the phone has no terminals (`features.terminals` is off), so xterm.js and its addons
 * (~530 KB) are left out of the bundle. Same exports, never called on the phone.
 */

import type { XtermHandle } from "../features/terminals/xterm";

export type { XtermHandle };

export function terminalTheme(): Record<string, string> {
  return {};
}

export function createXterm(): XtermHandle {
  throw new Error("terminals are not available in the mobile app");
}
