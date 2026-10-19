// « Demander au projet » in a Claude Code terminal (2026-10-18): the button, the panel
// and its terminal, on the mock backend.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { askTerminalKey } from "./AskPanel";

const FOLDER = "/Users/user/Projets/taido";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function project() {
  const p = await backend().commands.createSubject({
    name: "Taido",
    color: null,
    rootPath: FOLDER,
    parentId: null,
  });
  act(() => useUi.getState().setView({ kind: "subject", subjectId: p.id }));
  return p;
}

const panel = () => screen.getByRole("region", { name: fr.ask.title });
const claudeView = fr.terminals.view(fr.terminals.agent("claude"));

/** Clicks « Demander au projet » once the project view has settled (it mounts twice). */
async function openPanel(name: string = fr.ask.button) {
  const user = userEvent.setup();
  await waitFor(async () => {
    const done = () => useUi.getState().askSubjectId !== null;
    if (!done()) await user.click(screen.getByRole("button", { name }));
    expect(done()).toBe(true);
  });
  return user;
}

async function askTerminals(subjectId: string) {
  return (await backend().commands.listTerminals()).filter(
    (t) => t.taskId === askTerminalKey(subjectId),
  );
}

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  resetFakeTerms();
  setXtermFactory(createFakeXterm);
  setTerminalList([]);
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  resetRegistry();
  setXtermFactory(null);
});

describe("Demander au projet", () => {
  it("opens Claude Code in the project's folder, in the panel", async () => {
    render(<App />);
    const p = await project();
    await openPanel();
    expect(
      await within(panel()).findByRole("region", { name: claudeView }),
    ).toBeInTheDocument();
    const [t] = await askTerminals(p.id);
    expect(t).toMatchObject({
      kind: "agent",
      agent: "claude",
      cwd: FOLDER,
      running: true,
    });
  });

  it("finds the same Claude again after closing the panel", async () => {
    render(<App />);
    const p = await project();
    const user = await openPanel();
    await within(panel()).findByRole("region", { name: claudeView });
    await user.click(
      within(panel()).getByRole("button", { name: fr.ask.close }),
    );
    expect(screen.queryByRole("region", { name: fr.ask.title })).toBeNull();
    await openPanel();
    await within(panel()).findByRole("region", { name: claudeView });
    expect(await askTerminals(p.id)).toHaveLength(1);
  });

  it("starts another conversation on « Nouvelle conversation »", async () => {
    render(<App />);
    const p = await project();
    const user = await openPanel();
    await within(panel()).findByRole("region", { name: claudeView });
    const [first] = await askTerminals(p.id);
    await user.click(
      within(panel()).getByRole("button", { name: fr.ask.newConversation }),
    );
    await waitFor(async () => {
      const list = await askTerminals(p.id);
      expect(list).toHaveLength(1);
      expect(list[0].id).not.toBe(first.id);
    });
  });

  it("hides behind an open task, Claude still there", async () => {
    render(<App />);
    const p = await project();
    const t = await backend().commands.createTask({
      title: "Une tâche",
      description: null,
      subjectId: p.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await openPanel();
    await within(panel()).findByRole("region", { name: claudeView });
    act(() => useUi.getState().openTask(t.id));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: fr.ask.title })).toBeNull(),
    );
    act(() => useUi.getState().openTask(null));
    expect(
      await within(panel()).findByRole("region", { name: claudeView }),
    ).toBeInTheDocument();
    expect(await askTerminals(p.id)).toHaveLength(1);
  });

  it("has the dictation mic, like the terminals", async () => {
    backend().voice.model = { state: "ready" };
    render(<App />);
    await project();
    await openPanel();
    expect(
      await within(panel()).findByRole("button", { name: fr.voice.dictate }),
    ).toBeInTheDocument();
  });

  it("can be made wider or narrower, like the task panel", async () => {
    window.localStorage.removeItem("todo.askPanelWidth");
    render(<App />);
    await project();
    const user = await openPanel();
    const handle = within(panel()).getByRole("separator", {
      name: fr.ask.resize,
    });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(
        before,
      ),
    );
    expect(window.localStorage.getItem("todo.askPanelWidth")).not.toBeNull();
  });
});
