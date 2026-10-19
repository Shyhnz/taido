import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands } from "../../lib/ipc";
import { MOCK_VOICE_SENTENCES } from "../../lib/mock-voice";
import { resetUi, useUi } from "../../stores/ui";
import { openTerminal } from "../terminals/actions";
import {
  createFakeXterm,
  fakeTerms,
  resetFakeTerms,
} from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { backend, taskWithFolder } from "../terminals/testSupport";
import { HOLD_MS } from "./spaceHold";
import { useVoice } from "./voice";

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await screen.findByRole("region", {
    name: "Panneau de la tâche",
  });
  await within(panel).findByRole("textbox", { name: "Titre de la tâche" });
  return panel;
}

async function claudeTerminal() {
  const task = await taskWithFolder();
  render(<App />);
  const panel = await openPanel(task.id);
  const info = await act(() =>
    openTerminal(task.id, "agent", { agent: "claude" }),
  );
  if (!info) throw new Error("terminal not opened");
  return { panel, info };
}

interface Written {
  terminalId: string;
  data: string;
}

function written(spy: { mock: { calls: unknown[][] } }, terminalId: string) {
  return spy.mock.calls
    .map((call): Written => call[0] as Written)
    .filter((i) => i.terminalId === terminalId)
    .map((i) => i.data)
    .join("");
}

function key(type: string, k: string, repeat = false): KeyboardEvent {
  return new KeyboardEvent(type, {
    key: k,
    code: k === " " ? "Space" : k === "Escape" ? "Escape" : `Key${k}`,
    repeat,
  });
}

describe("dictation", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
    useToasts.setState({ toasts: [] });
    useVoice.setState({ phase: "idle", terminalId: null, level: 0 });
    window.localStorage.clear();
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("first click offers the model download, then the mic writes the text", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(commands, "writeTerminal");
    const { panel, info } = await claudeTerminal();
    const mic = await within(panel).findByRole("button", { name: "Dicter" });
    await user.click(mic);
    const setup = await screen.findByRole("dialog", { name: "Dicter à l'IA" });
    expect(setup).toHaveTextContent("549 Mo");
    await user.click(
      within(setup).getByRole("button", { name: "Télécharger" }),
    );
    await within(setup).findByText(/C'est prêt/);
    await user.click(within(setup).getByRole("button", { name: "OK" }));

    await user.click(mic);
    const stop = await within(panel).findByRole("button", {
      name: "Arrêter et écrire le texte",
    });
    expect(within(panel).getByText(/J'écoute/)).toBeInTheDocument();
    await user.click(stop);
    await waitFor(() =>
      expect(written(write, info.id)).toBe(MOCK_VOICE_SENTENCES[0]),
    );
    // Never sent: no Enter after the text.
    expect(written(write, info.id)).not.toContain("\r");
    expect(useVoice.getState().phase).toBe("idle");
  });

  it("no mic on a shell terminal", async () => {
    const task = await taskWithFolder();
    render(<App />);
    const panel = await openPanel(task.id);
    await act(() => openTerminal(task.id, "shell"));
    await within(panel).findByRole("button", { name: "Nouveau terminal" });
    expect(within(panel).queryByRole("button", { name: "Dicter" })).toBeNull();
  });

  it("Space: a tap types a space, a long press dictates", async () => {
    backend().voice.model = { state: "ready" };
    const write = vi.spyOn(commands, "writeTerminal");
    const { panel, info } = await claudeTerminal();
    await within(panel).findByRole("button", { name: "Dicter" });
    const term = fakeTerms[fakeTerms.length - 1];
    const handler = term.keyHandler;
    if (!handler) throw new Error("no key handler");

    expect(handler(key("keydown", " "))).toBe(false);
    expect(handler(key("keyup", " "))).toBe(false);
    await waitFor(() => expect(written(write, info.id)).toBe(" "));

    handler(key("keydown", " "));
    await act(() => new Promise((r) => setTimeout(r, HOLD_MS + 50)));
    handler(key("keydown", " ", true));
    await waitFor(() => expect(useVoice.getState().phase).toBe("recording"));
    handler(key("keyup", " "));
    await waitFor(() =>
      expect(written(write, info.id)).toBe(` ${MOCK_VOICE_SENTENCES[0]}`),
    );
  });

  it("Échap cancels without writing", async () => {
    backend().voice.model = { state: "ready" };
    const user = userEvent.setup();
    const write = vi.spyOn(commands, "writeTerminal");
    const { panel, info } = await claudeTerminal();
    await user.click(
      await within(panel).findByRole("button", { name: "Dicter" }),
    );
    await waitFor(() => expect(useVoice.getState().phase).toBe("recording"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useVoice.getState().phase).toBe("idle"));
    expect(backend().voice.recording).toBeNull();
    expect(written(write, info.id)).toBe("");
  });

  it("a refused microphone says where to allow it", async () => {
    backend().voice.model = { state: "ready" };
    backend().voice.micDenied = true;
    const user = userEvent.setup();
    const { panel } = await claudeTerminal();
    await user.click(
      await within(panel).findByRole("button", { name: "Dicter" }),
    );
    expect(
      await screen.findByText("Taido n'a pas accès au micro."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ouvrir les réglages du micro" }),
    ).toBeInTheDocument();
  });
});
