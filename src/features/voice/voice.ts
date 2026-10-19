/**
 * Dictation in Claude and Codex terminals. The core records and
 * transcribes; this store only follows what the UI shows (listening, transcribing, the level)
 * and pastes the text into the terminal, without Enter.
 */

import { create } from "zustand";
import type { TerminalInfo, VoiceStatus } from "../../bindings";
import { showError, showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { commands, errorKind, errorMessage } from "../../lib/ipc";
import { readableError } from "../../lib/run";
import { pasteIntoTerminal } from "../terminals/registry";

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

interface VoiceStore {
  status: VoiceStatus | null;
  /** Réglages › Agents « Garder Espace enfoncée pour dicter ». */
  spaceHold: boolean;
  phase: VoicePhase;
  terminalId: string | null;
  level: number;
  startedAt: number | null;
}

export const useVoice = create<VoiceStore>(() => ({
  status: null,
  spaceHold: true,
  phase: "idle",
  terminalId: null,
  level: 0,
  startedAt: null,
}));

/** A text field that takes dictation besides terminals (« Demander au projet »). */
export interface DictationTarget {
  /** Writes the heard text. */
  write: (text: string) => void;
  /** Types a space at the caret (« Garder Espace enfoncée » released early). */
  typeSpace: () => void;
}

/** Text fields that take dictation, by target id: the heard text goes to them. */
const textTargets = new Map<string, DictationTarget>();

/** Registers (or with `null` removes) a text field as dictation target `id`. */
export function setDictationTarget(
  id: string,
  target: DictationTarget | null,
): void {
  if (target) textTargets.set(id, target);
  else textTargets.delete(id);
}

export function dictationTarget(id: string): DictationTarget | undefined {
  return textTargets.get(id);
}

/**
 * « Garder Espace enfoncée » in a text field: the key events of the field go through the
 * same hold as the terminals' (installed by the controller). Returns true when the event is
 * consumed (the field must not type it).
 */
let fieldKeyHook: ((id: string, e: KeyboardEvent) => boolean) | null = null;

export function setFieldKeyHook(
  hook: ((id: string, e: KeyboardEvent) => boolean) | null,
): void {
  fieldKeyHook = hook;
}

export function dictationFieldKey(id: string, e: KeyboardEvent): boolean {
  return fieldKeyHook?.(id, e) ?? false;
}

/** What to do once a start still in progress ends (Space released, Échap). */
let afterStart: "stop" | "cancel" | null = null;

/** Dictation exists here and the terminal is an agent's. */
export function canDictate(
  terminal: TerminalInfo,
  status: VoiceStatus | null,
): boolean {
  return (
    terminal.kind === "agent" &&
    terminal.running &&
    status !== null &&
    status.model.state !== "unavailable"
  );
}

export function modelReady(status: VoiceStatus | null): boolean {
  return status?.model.state === "ready";
}

function reset(): void {
  useVoice.setState({
    phase: "idle",
    terminalId: null,
    level: 0,
    startedAt: null,
  });
}

function fail(error: unknown): void {
  console.error(errorMessage(error), error);
  if (errorKind(error) === "mic_denied") {
    showToast({
      message: fr.voice.micDenied,
      tone: "error",
      action: {
        label: fr.voice.openMicSettings,
        onAction: () => void commands.voiceOpenMicSettings().catch(() => {}),
      },
    });
    return;
  }
  showError(readableError(error));
}

export async function startDictation(terminalId: string): Promise<void> {
  if (useVoice.getState().phase !== "idle") return;
  afterStart = null;
  useVoice.setState({ phase: "starting", terminalId, level: 0 });
  try {
    await commands.voiceStart(terminalId);
  } catch (error) {
    reset();
    fail(error);
    return;
  }
  useVoice.setState({ phase: "recording", startedAt: Date.now() });
  const then = afterStart;
  afterStart = null;
  if (then === "stop") await stopDictation();
  if (then === "cancel") await cancelDictation();
}

export async function stopDictation(): Promise<void> {
  const { phase, terminalId } = useVoice.getState();
  if (phase === "starting") {
    afterStart = "stop";
    return;
  }
  if (phase !== "recording" || terminalId === null) return;
  useVoice.setState({ phase: "transcribing", level: 0 });
  try {
    const text = await commands.voiceStop();
    const target = textTargets.get(terminalId);
    if (text && target) target.write(text);
    else if (text) pasteIntoTerminal(terminalId, text);
    else showToast({ message: fr.voice.heardNothing, duration: 2500 });
  } catch (error) {
    fail(error);
  } finally {
    reset();
  }
}

export async function cancelDictation(): Promise<void> {
  const { phase } = useVoice.getState();
  if (phase === "starting") {
    afterStart = "cancel";
    return;
  }
  if (phase !== "recording") return;
  reset();
  await commands.voiceCancel().catch(fail);
}

/** Mic button: starts, or stops when this terminal is listening. */
export function toggleDictation(terminalId: string): void {
  const { phase, terminalId: current } = useVoice.getState();
  if (phase === "idle") void startDictation(terminalId);
  else if (current === terminalId) void stopDictation();
}
