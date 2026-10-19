/**
 * xterm.js setup, kept apart from the registry so tests can replace it: jsdom has
 * no canvas, no WebGL and no font metrics.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "../../lib/ipc";

/** What the registry needs from a terminal: the real xterm `Terminal`, or a test double. */
export interface XtermHandle {
  term: Terminal;
  fit: () => void;
  /** Loads the WebGL renderer; returns its disposer, or `null` (DOM renderer kept). */
  enableWebgl: () => (() => void) | null;
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** Terminal colors from the design tokens of the current theme (light or dark). */
export function terminalTheme(): ITheme {
  const background = cssVar("--bg-terminal", "#ffffff");
  const foreground = cssVar("--text", "#202020");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: cssVar("--bg-nav-active", "#e8edfb"),
  };
}

function openLink(_event: MouseEvent, uri: string): void {
  if (isTauri) void openUrl(uri);
  else window.open(uri, "_blank", "noopener");
}

export function createXterm(): XtermHandle {
  const term = new Terminal({
    allowProposedApi: true, // required by `term.unicode` (unicode11 addon)
    macOptionIsMeta: true,
    scrollback: 10_000,
    fontFamily: cssVar(
      "--font-mono",
      '"Geist Mono Variable", ui-monospace, monospace',
    ),
    fontSize: 13,
    lineHeight: 1.25,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon(openLink));
  return {
    term,
    fit: () => fit.fit(),
    enableWebgl: () => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
        return () => webgl.dispose();
      } catch {
        return null; // DOM renderer fallback
      }
    },
  };
}
