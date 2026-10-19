/**
 * Mounted once (TerminalsHost): follows the dictation status and the microphone level from the
 * core, installs « Garder Espace enfoncée » on the terminals, and Échap to cancel.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { VoiceStatus } from "../../bindings";
import { commands, events } from "../../lib/ipc";
import { useSettings } from "../../lib/queries";
import { setTerminalKeyHook, typeIntoTerminal } from "../terminals/registry";
import { SpaceHold } from "./spaceHold";
import {
  cancelDictation,
  dictationTarget,
  modelReady,
  setFieldKeyHook,
  startDictation,
  stopDictation,
  useVoice,
} from "./voice";

export const VOICE_STATUS_KEY = ["voice-status"] as const;

export function useVoiceStatus(): VoiceStatus | null {
  return (
    useQuery({ queryKey: VOICE_STATUS_KEY, queryFn: commands.voiceStatus })
      .data ?? null
  );
}

export function useVoiceController(): void {
  const client = useQueryClient();
  const status = useVoiceStatus();
  const { data: settings } = useSettings();

  useEffect(() => {
    useVoice.setState({ status });
  }, [status]);

  useEffect(() => {
    if (settings) useVoice.setState({ spaceHold: settings.voiceSpaceHold });
  }, [settings]);

  useEffect(() => {
    const changed = events.voiceChanged.listen(({ payload }) =>
      client.setQueryData<VoiceStatus>(VOICE_STATUS_KEY, payload.status),
    );
    const level = events.voiceLevel.listen(({ payload }) => {
      if (useVoice.getState().phase === "recording")
        useVoice.setState({ level: payload.level ?? 0 });
    });
    return () => {
      void changed.then((stop) => stop());
      void level.then((stop) => stop());
    };
  }, [client]);

  useEffect(() => {
    const hold = new SpaceHold({
      start: (id) => void startDictation(id),
      stop: () => void stopDictation(),
      typeSpace: (id) => {
        const field = dictationTarget(id);
        if (field) field.typeSpace();
        else typeIntoTerminal(id, " ");
      },
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    });
    setTerminalKeyHook((info, e) => {
      const v = useVoice.getState();
      const enabled =
        info.kind === "agent" &&
        info.running &&
        v.spaceHold &&
        v.phase === "idle" &&
        modelReady(v.status);
      return hold.handle(info.id, e, enabled);
    });
    // The same hold in a text field that takes dictation (« Demander au projet »).
    setFieldKeyHook((id, e) => {
      const v = useVoice.getState();
      const enabled =
        dictationTarget(id) !== undefined &&
        v.spaceHold &&
        v.phase === "idle" &&
        modelReady(v.status);
      return hold.handle(id, e, enabled);
    });
    // Échap while listening cancels, before the terminal sees it (it would interrupt Claude).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { phase } = useVoice.getState();
      if (phase !== "starting" && phase !== "recording") return;
      e.preventDefault();
      e.stopPropagation();
      void cancelDictation();
    };
    const onBlur = () => hold.blur();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      setTerminalKeyHook(null);
      setFieldKeyHook(null);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
