/**
 * Terminal registry: one xterm instance per terminal kept by the core, created
 * when the terminal appears and kept while it exists, even when no panel shows it.
 *
 * Each instance lives in its own container. Hidden containers sit in an off-screen,
 * inert parking zone (never `display: none`, which breaks the size computation) and are
 * **moved** into the visible host, never re-created. Creating an instance attaches it to the
 * core, which replays the terminal's buffer: this also restores every terminal after a
 * webview reload. WebGL is enabled only while a terminal is shown (browsers cap the number
 * of WebGL contexts).
 *
 * Every function is idempotent, so React StrictMode's double effects are harmless.
 */

import type { TerminalInfo } from "../../bindings";
import { attachTerminal, commands, errorMessage } from "../../lib/ipc";
import { createXterm, terminalTheme, type XtermHandle } from "./xterm";

/** Debounce of the ResizeObserver before `fit()` + `resize_terminal`. */
export const REFIT_DEBOUNCE_MS = 50;

interface Entry {
  info: TerminalInfo;
  handle: XtermHandle;
  el: HTMLDivElement;
  /** Host currently showing the terminal, if any. */
  host: HTMLElement | null;
  /** Hides the terminal from its current host. */
  hide: (() => void) | null;
  /** Last size sent to the core. */
  size: { cols: number; rows: number } | null;
}

let factory: () => XtermHandle = createXterm;
/**
 * Key events of every terminal go through this first (dictation, src/features/voice); `true`
 * means consumed, xterm ignores the key.
 */
type KeyHook = (info: TerminalInfo, e: KeyboardEvent) => boolean;
let keyHook: KeyHook | null = null;
const entries = new Map<string, Entry>();
let parking: HTMLDivElement | null = null;
let themeObserver: MutationObserver | null = null;
let pendingFocus: string | null = null;
/**
 * Hosts shown before their terminal reached the registry (the panel can list a new terminal
 * before the terminal list query does): filled as soon as `syncTerminals` creates it.
 */
const waitingHosts = new Map<string, HTMLElement>();
/** Instances already disposed: late output of a closed terminal is dropped. */
const disposedEntries = new WeakSet<object>();

/** Tests: replaces the xterm factory (`null` restores the real one). */
export function setXtermFactory(next: (() => XtermHandle) | null): void {
  factory = next ?? createXterm;
}

function logError(what: string) {
  return (error: unknown) => console.error(what, errorMessage(error), error);
}

function parkingZone(): HTMLDivElement {
  if (parking?.isConnected) return parking;
  parking = document.createElement("div");
  parking.dataset.terminalParking = "";
  // Off screen but laid out, so xterm keeps measuring; inert keeps it out of the tab order.
  parking.setAttribute("inert", "");
  parking.setAttribute("aria-hidden", "true");
  Object.assign(parking.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "800px",
    height: "600px",
    overflow: "hidden",
    pointerEvents: "none",
  });
  document.body.appendChild(parking);
  return parking;
}

/** Follows the light / dark switch and the colour theme of <html> (src/lib/theme.ts). */
function watchTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => {
    const theme = terminalTheme();
    for (const entry of entries.values())
      entry.handle.term.options.theme = theme;
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color"],
  });
}

function write(entry: Entry, data: string): void {
  if (!entry.info.running) return;
  commands
    .writeTerminal({ terminalId: entry.info.id, data })
    .catch(logError("write_terminal failed"));
}

function create(info: TerminalInfo): Entry {
  const el = document.createElement("div");
  el.dataset.terminalId = info.id;
  el.style.width = "100%";
  el.style.height = "100%";
  parkingZone().appendChild(el);
  const handle = factory();
  const entry: Entry = { info, handle, el, host: null, hide: null, size: null };
  const { term } = handle;
  term.open(el);
  term.onData((data) => write(entry, data));
  term.attachCustomKeyEventHandler((e) => {
    if (keyHook?.(entry.info, e)) {
      e.preventDefault();
      return false;
    }
    // Shift+Enter: a newline in Claude Code (Ctrl+J).
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (e.type === "keydown") {
        e.preventDefault();
        write(entry, "\n");
      }
      return false;
    }
    if (e.metaKey) {
      // ⌘C copies a selection; without one nothing is sent (Ctrl+C stays the interrupt).
      if (
        e.type === "keydown" &&
        e.key.toLowerCase() === "c" &&
        term.hasSelection()
      ) {
        void navigator.clipboard?.writeText(term.getSelection());
      }
      // Other ⌘ keys belong to the app (⌘T, ⌘⇧F, ⌘1…); ⌘V pastes through the paste event,
      // which xterm handles (bracketed paste).
      return false;
    }
    return true;
  });
  // Late output of a closed terminal must not reach its disposed instance.
  attachTerminal(info.id, (bytes) => {
    if (!disposedEntries.has(entry)) term.write(bytes);
  }).catch(logError("attach_terminal failed"));
  return entry;
}

function dispose(entry: Entry): void {
  disposedEntries.add(entry);
  entry.hide?.();
  entries.delete(entry.info.id);
  entry.handle.term.dispose();
  entry.el.remove();
  if (pendingFocus === entry.info.id) pendingFocus = null;
}

/**
 * Mirrors the core's terminal list: creates (and attaches) the new ones, updates the known
 * ones, disposes those the core no longer keeps.
 */
export function syncTerminals(list: TerminalInfo[]): void {
  watchTheme();
  const ids = new Set(list.map((t) => t.id));
  for (const entry of [...entries.values()]) {
    if (!ids.has(entry.info.id)) dispose(entry);
  }
  for (const info of list) {
    const entry = entries.get(info.id);
    if (entry) {
      entry.info = info;
      continue;
    }
    entries.set(info.id, create(info));
    const host = waitingHosts.get(info.id);
    if (host) {
      waitingHosts.delete(info.id);
      if (host.isConnected) showTerminal(info.id, host);
    }
  }
}

/**
 * Moves the terminal into `host` (from the parking zone or another host), enables WebGL,
 * fits it and keeps fitting it on resize. Returns the function that parks it again.
 */
export function showTerminal(id: string, host: HTMLElement): () => void {
  const entry = entries.get(id);
  if (!entry) {
    waitingHosts.set(id, host);
    return () => {
      if (waitingHosts.get(id) === host) {
        waitingHosts.delete(id);
        return;
      }
      // Shown meanwhile by `syncTerminals`: park it again.
      const shown = entries.get(id);
      if (shown?.host === host) shown.hide?.();
    };
  }
  if (entry.host === host && entry.hide) return entry.hide;
  entry.hide?.();
  host.appendChild(entry.el);
  entry.host = host;
  const { handle } = entry;
  const disposeWebgl = handle.enableWebgl();

  const refit = () => {
    if (entry.host !== host) return;
    try {
      handle.fit();
    } catch {
      return; // not measurable yet (zero-size host)
    }
    const { cols, rows } = handle.term;
    if (entry.size?.cols === cols && entry.size?.rows === rows) return;
    entry.size = { cols, rows };
    if (!entry.info.running) return;
    commands
      .resizeTerminal({ terminalId: id, cols, rows })
      .catch(logError("resize_terminal failed"));
  };
  refit();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(refit, REFIT_DEBOUNCE_MS);
        });
  observer?.observe(host);

  if (pendingFocus === id) {
    // Next task: a show immediately undone (StrictMode's double effect) would park the
    // container in the inert zone and drop the focus.
    setTimeout(() => {
      if (pendingFocus !== id || entry.host !== host) return;
      pendingFocus = null;
      handle.term.focus();
    }, 0);
  }

  const hide = () => {
    observer?.disconnect();
    clearTimeout(timer);
    disposeWebgl?.();
    if (entry.el.parentElement === host) parkingZone().appendChild(entry.el);
    if (entry.host === host) entry.host = null;
    if (entry.hide === hide) entry.hide = null;
  };
  entry.hide = hide;
  return hide;
}

/** Puts the keyboard focus in the terminal now, or as soon as it is shown. */
export function focusTerminal(id: string): void {
  const entry = entries.get(id);
  if (entry?.host) entry.handle.term.focus();
  else pendingFocus = id;
}

/**
 * Terminal under the viewport point (x, y), in CSS pixels; otherwise the only shown terminal,
 * if there is exactly one. `null` when files dropped there have nowhere to go.
 */
export function terminalAt(x: number, y: number): string | null {
  const hit = document
    .elementFromPoint?.(x, y)
    ?.closest<HTMLElement>("[data-terminal-host]")?.dataset.terminalHost;
  if (hit && entries.get(hit)?.host) return hit;
  const shown = [...entries.values()].filter((entry) => entry.host);
  return shown.length === 1 ? shown[0].info.id : null;
}

/** Highlights the host of the terminal files would be dropped on (`null`: none). */
export function markDropTarget(id: string | null): void {
  for (const entry of entries.values()) {
    if (!entry.host) continue;
    if (entry.info.id === id) entry.host.dataset.dropTarget = "";
    else delete entry.host.dataset.dropTarget;
  }
}

/** Types `text` into a running terminal as a paste (bracketed when the program asks for it). */
export function pasteIntoTerminal(id: string, text: string): void {
  const entry = entries.get(id);
  if (!entry?.info.running || !text) return;
  entry.handle.term.paste(text);
  entry.handle.term.focus();
}

/** Installs the key hook of the dictation (`null` removes it). */
export function setTerminalKeyHook(hook: KeyHook | null): void {
  keyHook = hook;
}

/** Types `data` as if from the keyboard (same path and order as the keys typed). */
export function typeIntoTerminal(id: string, data: string): void {
  const entry = entries.get(id);
  if (!entry?.info.running) return;
  entry.handle.term.input(data, true);
}

/** Size of the shown terminal of a task, to open the next one at the same size. */
export function shownSize(): { cols: number; rows: number } | null {
  for (const entry of entries.values()) {
    if (entry.host && entry.size) return entry.size;
  }
  return null;
}

/** Tests: ids of the live instances. */
export function registeredTerminalIds(): string[] {
  return [...entries.keys()];
}

/** Tests: forgets every instance and the parking zone. */
export function resetRegistry(): void {
  for (const entry of [...entries.values()]) dispose(entry);
  parking?.remove();
  parking = null;
  themeObserver?.disconnect();
  themeObserver = null;
  pendingFocus = null;
  waitingHosts.clear();
}
