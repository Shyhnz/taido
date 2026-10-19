/**
 * Keeps one xterm instance per terminal of the core, whatever task is open, and
 * answers ⌘Q (`quit_requested`) types the paths of files dropped on a terminal, and runs the dictation
 * (`useVoiceController`). Renders nothing: the instances live in the
 * registry's parking zone until a panel shows them.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { events, isTauri } from "../../lib/ipc";
import { useTerminals } from "../../lib/queries";
import { useVoiceController } from "../voice/useVoiceController";
import { requestQuit } from "./actions";
import { handleDragDrop } from "./fileDrop";
import { syncTerminals } from "./registry";
import { setTerminalList } from "./terminalList";

export function TerminalsHost() {
  const { data } = useTerminals();
  useVoiceController();

  useEffect(() => {
    if (!data) return;
    setTerminalList(data);
    syncTerminals(data);
  }, [data]);

  useEffect(() => {
    const unlisten = events.quitRequested.listen(() => {
      void requestQuit();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) =>
      handleDragDrop(event.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return null;
}
