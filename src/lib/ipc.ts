/**
 * The only module the app uses to talk to the core.
 *
 * In Tauri it forwards to the generated bindings (src/bindings.ts). In a plain browser
 * (`pnpm dev`) and in tests it uses the in-memory mock backend, which follows the same rules
 * and emits the same events.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  type AskUpdated,
  type CountsChanged,
  type DataChanged,
  type ErrorKind,
  type ErrorPayload,
  type NotificationOpened,
  type QuitRequested,
  type SyncChanged,
  type TaskStateChanged,
  type TerminalExited,
  type TerminalSize,
  commands as tauriCommands,
  events as tauriEvents,
  type VoiceChanged,
  type VoiceLevel,
} from "../bindings";
import { MockBackend } from "./mock-backend";
import type { WebAttachmentFiles } from "./web-files";

export type Commands = typeof tauriCommands;

/** Event payload delivered to listeners (subset of Tauri's `Event<T>`). */
export interface IpcEvent<T> {
  payload: T;
}

export interface IpcEventChannel<T> {
  listen: (cb: (event: IpcEvent<T>) => void) => Promise<() => void>;
}

export interface Events {
  countsChanged: IpcEventChannel<CountsChanged>;
  dataChanged: IpcEventChannel<DataChanged>;
  terminalExited: IpcEventChannel<TerminalExited>;
  quitRequested: IpcEventChannel<QuitRequested>;
  taskStateChanged: IpcEventChannel<TaskStateChanged>;
  syncChanged: IpcEventChannel<SyncChanged>;
  notificationOpened: IpcEventChannel<NotificationOpened>;
  voiceChanged: IpcEventChannel<VoiceChanged>;
  voiceLevel: IpcEventChannel<VoiceLevel>;
  askUpdated: IpcEventChannel<AskUpdated>;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

declare global {
  /**
   * Seam: the PWA entry (src/mobile/main.tsx) loads its persisted backend (a
   * `MockBackend` subclass, docs/SYNC.md § Mobile app) and sets it here **before** importing
   * the app, so this module never imports mobile code.
   */
  var __TODO_BACKEND__: MockBackend | undefined;
}

/**
 * `pnpm dev` at `/?premier-lancement`: an empty app whose first-launch guide never ran, as after
 * an install.
 */
function browserMock(): MockBackend {
  const firstLaunch =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("premier-lancement");
  const backend = new MockBackend({ seed: !firstLaunch });
  if (firstLaunch) {
    backend.state.settings.tutorial.status = "not_started";
  }
  return backend;
}

/** The mock backend, or `null` inside Tauri. Tests use it to reset or inspect data. */
export const mockBackend: MockBackend | null = isTauri
  ? null
  : (globalThis.__TODO_BACKEND__ ?? browserMock());

// The mock commands read the backend state at call time, so `reset()` is always honoured.
export const commands: Commands = mockBackend
  ? (mockBackend.commands satisfies Commands)
  : tauriCommands;

export const events: Events = mockBackend ? mockBackend.events : tauriEvents;

/**
 * The web app's attachment files (Taido V2.7 bis: added from the browser, sent to the account,
 * opened on demand), or `null` on the Mac and in the plain mock.
 */
export function webFiles(): WebAttachmentFiles | null {
  return mockBackend?.webFiles ?? null;
}

/**
 * The CSV of « Exporter les temps » built in the browser (Taido V2.8: the web app downloads
 * it), or `null` inside Tauri, where `exportTimeCsv` writes the file.
 */
export function webTimeCsv(days: number): string | null {
  return mockBackend?.timeCsv(days) ?? null;
}

/**
 * Replays the terminal's buffer into `onData`, then streams its output. Raw bytes:
 * `attach_terminal` is outside the generated bindings (src-tauri/src/commands/terminals.rs).
 * A terminal has one subscriber; attaching again replaces the previous one.
 */
export async function attachTerminal(
  terminalId: string,
  onData: (bytes: Uint8Array) => void,
): Promise<TerminalSize> {
  if (mockBackend) return mockBackend.terminals.attach(terminalId, onData);
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
  return invoke<TerminalSize>("attach_terminal", {
    terminalId,
    onData: channel,
  });
}

/** Opens a folder in the Finder (core `open_path`, bug #11). No-op in the mock. */
export async function openFolder(path: string): Promise<void> {
  await commands.openPath({ path, with: "finder", editor: null });
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/**
 * Raw technical detail of a rejected command (English, from the core). For the console only:
 * the UI shows `readableError` (src/lib/run.ts), built from `errorKind` (bug #12).
 */
export function errorMessage(error: unknown): string {
  if (isErrorPayload(error)) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** `kind` of a rejected command, or `null` when the error does not come from the core. */
export function errorKind(error: unknown): ErrorKind | null {
  if (!isErrorPayload(error)) return null;
  const kind = (error as Partial<ErrorPayload>).kind;
  return kind !== undefined && ERROR_KINDS.includes(kind) ? kind : null;
}

// A record, so a kind added to the core cannot be forgotten here (it would not type-check).
const KNOWN_KINDS: Record<ErrorKind, true> = {
  not_found: true,
  invalid: true,
  no_folder: true,
  folder_missing: true,
  claude_missing: true,
  codex_missing: true,
  internal: true,
  sync_auth: true,
  sync_rate_limited: true,
  sync_email_taken: true,
  sync_weak_password: true,
  sync_bad_email: true,
  sync_invalid_code: true,
  sync_mail_unavailable: true,
  sync_offline: true,
  sync_server: true,
  file_not_here: true,
  file_not_on_server: true,
  downloads_denied: true,
  disk_full: true,
  file_write_failed: true,
  mic_denied: true,
  voice_unavailable: true,
};
const ERROR_KINDS = Object.keys(KNOWN_KINDS) as ErrorKind[];

/** True when a command failed because the item no longer exists. */
export function isNotFound(error: unknown): boolean {
  return isErrorPayload(error) && (error as ErrorPayload).kind === "not_found";
}
