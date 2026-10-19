import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { TerminalInfo } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { commands } from "../../lib/ipc";
import { MOCK_PICKED_FOLDER } from "../../lib/mock-backend";
import { resetUi, useUi } from "../../stores/ui";
import { openTerminal, requestQuit } from "./actions";
import { createFakeXterm, resetFakeTerms } from "./fakeXterm";
import { resetRegistry, setXtermFactory } from "./registry";
import {
  cyclePanes,
  menuAgents,
  PANE_ROWS_KEY,
  resolvePanes,
} from "./SessionBlock";
import { setTerminalList } from "./terminalList";
import {
  backend,
  openRaw,
  taskWithFolder,
  taskWithoutFolder,
} from "./testSupport";

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await screen.findByRole("region", {
    name: "Panneau de la tâche",
  });
  await within(panel).findByRole("textbox", { name: "Titre de la tâche" });
  return panel;
}

/**
 * Header of a focus-mode pane by its place (« de gauche », « en bas à droite »…): its name
 * ends with the terminal shown.
 */
function paneHeader(panel: HTMLElement, place: string): HTMLElement {
  return within(panel).getByRole("button", {
    name: new RegExp(`^Terminal du volet ${place} : `),
  });
}

describe("terminals in the task panel", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
    useToasts.setState({ toasts: [] });
    window.localStorage.clear();
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("« + » offers only the installed agents", async () => {
    backend().state.codex.found = false;
    const task = await taskWithFolder();
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    await act(() => openTerminal(task.id, "shell"));
    await user.click(
      await within(panel).findByRole("button", { name: "Nouveau terminal" }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Claude Code…", "Shell", "Commande…"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("menuAgents: the default first, only installed ones, the default when none", () => {
    expect(menuAgents("claude", undefined)).toEqual(["claude", "codex"]);
    expect(menuAgents("codex", ["claude", "codex"])).toEqual([
      "codex",
      "claude",
    ]);
    expect(menuAgents("claude", ["claude"])).toEqual(["claude"]);
    expect(menuAgents("claude", ["codex"])).toEqual(["codex"]);
    expect(menuAgents("codex", [])).toEqual(["codex"]);
  });

  it("shows the « Session » block only once the task has a terminal", async () => {
    const task = await taskWithFolder();
    render(<App />);
    const panel = await openPanel(task.id);
    expect(within(panel).queryByText("Session")).toBeNull();

    await act(() => openTerminal(task.id, "shell"));
    const tabs = await within(panel).findByRole("tablist", {
      name: "Terminaux de la tâche",
    });
    expect(within(tabs).getByRole("tab", { name: "Shell" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await within(panel).findByRole("region", { name: "Terminal Shell" }),
    ).toBeInTheDocument();
  });

  it("launches Claude Code from ⌘T in one step, without a first message", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder("Exporter le CSV");
    const spy = vi.spyOn(commands, "openTerminal");
    render(<App />);
    await openPanel(task.id);

    await user.keyboard("{Meta>}t{/Meta}");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // No dialog: the user talks to Claude; Claude only knows the task (context file).
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spy.mock.calls[0][0]).toMatchObject({
      taskId: task.id,
      kind: "agent",
      initialPrompt: null,
      addTaskContext: true,
    });
    expect(
      await screen.findByRole("tab", { name: "Claude Code" }),
    ).toBeInTheDocument();
  });

  it("opens a shell with ⌘⇧T and moves between tabs with ⌘⇧[ and ⌘⇧]", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", {
      name: "Claude Code",
      selected: true,
    });

    await user.keyboard("{Meta>}{Shift>}t{/Shift}{/Meta}");
    await within(panel).findByRole("tab", { name: "Shell", selected: true });

    // Shift turns the key into `{` / `}`: the physical key decides.
    await user.keyboard("{Meta>}{Shift>}[BracketLeft]{/Shift}{/Meta}");
    await within(panel).findByRole("tab", {
      name: "Claude Code",
      selected: true,
    });
    // Wraps around from the first tab to the last.
    await user.keyboard("{Meta>}{Shift>}[BracketLeft]{/Shift}{/Meta}");
    await within(panel).findByRole("tab", { name: "Shell", selected: true });
    await user.keyboard("{Meta>}{Shift>}[BracketRight]{/Shift}{/Meta}");
    await within(panel).findByRole("tab", {
      name: "Claude Code",
      selected: true,
    });
  });

  it("asks for a folder when the task has none, then opens the terminal", async () => {
    const task = await taskWithoutFolder();
    const pick = vi.spyOn(commands, "pickFolder");
    const set = vi.spyOn(commands, "setTaskFolder");
    const info = await openTerminal(task.id, "shell");
    expect(pick).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      taskId: task.id,
      path: MOCK_PICKED_FOLDER,
    });
    expect(info?.cwd).toBe(MOCK_PICKED_FOLDER);
  });

  it("opens nothing when the folder question is cancelled", async () => {
    const task = await taskWithoutFolder();
    vi.spyOn(commands, "pickFolder").mockResolvedValue(null);
    expect(await openTerminal(task.id, "shell")).toBeUndefined();
    expect(await commands.listTerminals()).toEqual([]);
  });

  it("offers « Choisir un dossier » when the folder is missing", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const real = commands.openTerminal;
    vi.spyOn(commands, "openTerminal")
      .mockRejectedValueOnce({ kind: "folder_missing", message: "gone" })
      .mockImplementation(real);
    render(<App />);
    const pending = openTerminal(task.id, "shell");
    const dialog = await screen.findByRole("dialog", {
      name: "Dossier introuvable",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Choisir un dossier" }),
    );
    const info = await pending;
    expect(info?.kind).toBe("shell");
  });

  it("always confirms before closing a running Claude tab, not a shell", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    await openRaw(task.id, "shell");
    const close = vi.spyOn(commands, "closeTerminal");
    render(<App />);
    const panel = await openPanel(task.id);

    await user.click(
      await within(panel).findByRole("button", { name: "Fermer Shell" }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(
      await within(panel).findByRole("button", { name: "Fermer Claude Code" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Fermer la session Claude ?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(close).toHaveBeenCalledTimes(1);

    await user.click(
      within(panel).getByRole("button", { name: "Fermer Claude Code" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Fermer la session" }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(panel).queryByText("Session")).toBeNull(),
    );
  });

  it("asks before completing a task whose Claude session runs", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    const spy = vi.spyOn(commands, "setTaskCompleted");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Claude Code" });

    await user.click(within(panel).getByRole("button", { name: /^Terminer/ }));
    const dialog = await screen.findByRole("dialog", {
      name: "Une session tourne sur cette tâche",
    });
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("enters and leaves focus mode with ⌘⇧F and Escape, keeping the tab", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    await openRaw(task.id, "shell");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Shell", selected: true });

    await user.click(within(panel).getByRole("button", { name: "Mode focus" }));
    expect(useUi.getState().focusMode).toBe(true);
    expect(screen.queryByRole("navigation")).toBeNull();
    // Two panes with their headers: Claude on the left, the shell on the right.
    expect(paneHeader(panel, "de gauche")).toHaveAccessibleName(
      "Terminal du volet de gauche : Claude Code",
    );
    expect(paneHeader(panel, "de droite")).toHaveAccessibleName(
      "Terminal du volet de droite : Shell",
    );
    // Nothing under the terminals in focus mode (option A): no note, no subtasks.
    expect(within(panel).queryByRole("textbox", { name: "Note" })).toBeNull();

    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await user.keyboard("{Escape}");
    expect(useUi.getState().focusMode).toBe(false);
    // The panel is back as before, with the same active tab.
    expect(
      within(panel).getByRole("tab", { name: "Shell", selected: true }),
    ).toBeInTheDocument();

    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    expect(useUi.getState().focusMode).toBe(true);
    act(() => useUi.getState().openTask(null));
    expect(useUi.getState().focusMode).toBe(false);
  });

  it("gives the whole width back to the other terminal when a pane closes", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const claude = await openRaw(task.id, "agent");
    const shell = await openRaw(task.id, "shell");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Shell", selected: true });
    act(() => useUi.getState().setFocusMode(true));
    expect(panel.querySelector('[data-pane="1"]')).not.toBeNull();

    await user.click(
      within(panel).getByRole("button", { name: "Fermer Shell" }),
    );
    await waitFor(() =>
      expect(
        panel.querySelector(`[data-terminal-frame="${shell.id}"]`),
      ).toBeNull(),
    );
    // One terminal left: no panes, no empty pane beside it; « + » splits again.
    expect(panel.querySelector("[data-pane]")).toBeNull();
    expect(
      panel.querySelector(`[data-terminal-frame="${claude.id}"]`),
    ).not.toBeNull();
    expect(within(panel).queryByText("Ouvrir un terminal à côté")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Diviser/ })).toBeNull();
  });

  it("splits the right column for a third terminal and the left one for a fourth", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    await openRaw(task.id, "shell");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Shell", selected: true });
    act(() => useUi.getState().setFocusMode(true));
    const rowsName = { name: "Hauteur des volets" };
    expect(within(panel).queryByRole("separator", rowsName)).toBeNull();

    // A third terminal goes under the shell; Claude keeps the whole height.
    await act(() => openTerminal(task.id, "command", { command: "npm test" }));
    await waitFor(() =>
      expect(paneHeader(panel, "en bas à droite")).toHaveAccessibleName(
        "Terminal du volet en bas à droite : npm test",
      ),
    );
    expect(paneHeader(panel, "de gauche")).toHaveAccessibleName(
      "Terminal du volet de gauche : Claude Code",
    );
    expect(paneHeader(panel, "en haut à droite")).toHaveAccessibleName(
      "Terminal du volet en haut à droite : Shell",
    );
    expect(
      within(panel).queryByRole("button", { name: /autre terminal/ }),
    ).toBeNull();

    // The border between the rows: the arrows move it, double-click resets it; remembered.
    const rows = within(panel).getByRole("separator", rowsName);
    expect(rows).toHaveAttribute("aria-valuenow", "50");
    act(() => rows.focus());
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(rows).toHaveAttribute("aria-valuenow", "60");
    expect(window.localStorage.getItem(PANE_ROWS_KEY)).toBe("0.6");
    await user.dblClick(rows);
    expect(rows).toHaveAttribute("aria-valuenow", "50");
    expect(window.localStorage.getItem(PANE_ROWS_KEY)).toBe("0.5");

    // A fourth goes under Claude.
    await act(() =>
      openTerminal(task.id, "command", { command: "npm run dev" }),
    );
    await waitFor(() =>
      expect(paneHeader(panel, "en bas à gauche")).toHaveAccessibleName(
        "Terminal du volet en bas à gauche : npm run dev",
      ),
    );
    expect(paneHeader(panel, "en haut à gauche")).toHaveAccessibleName(
      "Terminal du volet en haut à gauche : Claude Code",
    );
    // A fifth replaces the terminal of the focused pane (the fourth, just opened).
    await act(() =>
      openTerminal(task.id, "command", { command: "git status" }),
    );
    await waitFor(() =>
      expect(paneHeader(panel, "en bas à gauche")).toHaveAccessibleName(
        "Terminal du volet en bas à gauche : git status",
      ),
    );
    expect(
      within(panel).getByRole("button", { name: "1 autre terminal" }),
    ).toBeInTheDocument();

    // Closing the shell: the hidden terminal takes its place.
    await user.click(
      within(panel).getByRole("button", { name: "Fermer Shell" }),
    );
    await waitFor(() =>
      expect(paneHeader(panel, "en haut à droite")).toHaveAccessibleName(
        "Terminal du volet en haut à droite : npm run dev",
      ),
    );
    expect(
      within(panel).queryByRole("button", { name: /autre terminal/ }),
    ).toBeNull();
    // Closing git status: three panes again, Claude on the whole height.
    await user.click(
      within(panel).getByRole("button", { name: "Fermer git status" }),
    );
    await waitFor(() =>
      expect(paneHeader(panel, "de gauche")).toHaveAccessibleName(
        "Terminal du volet de gauche : Claude Code",
      ),
    );
    expect(paneHeader(panel, "en haut à droite")).toHaveAccessibleName(
      "Terminal du volet en haut à droite : npm run dev",
    );
    expect(paneHeader(panel, "en bas à droite")).toHaveAccessibleName(
      "Terminal du volet en bas à droite : npm test",
    );

    // Claude picked in the bottom pane's menu: the two panes swap, the focus follows Claude.
    await user.click(paneHeader(panel, "en bas à droite"));
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitemcheckbox", { name: /^Claude Code/ }),
    );
    await waitFor(() =>
      expect(paneHeader(panel, "en bas à droite")).toHaveAccessibleName(
        "Terminal du volet en bas à droite : Claude Code",
      ),
    );
    expect(paneHeader(panel, "de gauche")).toHaveAccessibleName(
      "Terminal du volet de gauche : npm test",
    );
    const bottom = panel.querySelector('[data-place="bottomRight"]');
    await waitFor(() =>
      expect(bottom?.contains(document.activeElement)).toBe(true),
    );
    expect(bottom).toHaveAttribute("data-focused", "true");
  });

  it("follows the Claude session with the tab ring and the border, without action bar", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "agent");
    render(<App />);
    const panel = await openPanel(task.id);
    const tab = await within(panel).findByRole("tab", { name: "Claude Code" });
    const ringState = () =>
      tab
        .querySelector("[data-session-state]")
        ?.getAttribute("data-session-state");
    expect(ringState()).toBe("starting");
    // SessionStart after 600 ms: Idle.
    await waitFor(() => expect(ringState()).toBe("idle"));

    // A permission request: red border, red ring, and the waiting bar under the terminal.
    await act(() =>
      commands.writeTerminal({ terminalId: info.id, data: "/p\r" }),
    );
    await waitFor(() => expect(ringState()).toBe("waiting"));
    expect(
      panel.querySelector(`[data-terminal-frame="${info.id}"]`),
    ).toHaveAttribute("data-waiting", "true");
    // The ring is the priority ring. Option A: the state is carried by the
    // tab and the terminal, not repeated by the title.
    expect(
      within(panel).getByRole("button", { name: "Terminer" }),
    ).toBeInTheDocument();
    const title = within(panel).getByRole("textbox", {
      name: "Titre de la tâche",
    });
    expect(title.parentElement?.querySelector("[data-state-dot]")).toBeNull();
    const bar = panel.querySelector<HTMLElement>('[data-part="waiting-bar"]');
    expect(bar).toHaveTextContent("Claude attend ta réponse");
    // No « Répondre » button in the bar: the terminal is right above it (2026-10-05).
    expect(bar && within(bar).queryByRole("button")).toBeNull();

    // Answering happens in the terminal: no « Interrompre », « Répondre… »
    // nor « Aller au terminal »; the waiting bar goes once Claude works again.
    await act(() =>
      commands.writeTerminal({ terminalId: info.id, data: "go\r" }),
    );
    await waitFor(() => expect(ringState()).toBe("working"));
    for (const name of ["Interrompre", "Répondre…", "Aller au terminal"]) {
      expect(within(panel).queryByRole("button", { name })).toBeNull();
    }
    expect(
      within(panel).queryByRole("group", { name: "État de Claude" }),
    ).toBeNull();
    expect(panel.querySelector('[data-part="waiting-bar"]')).toBeNull();
    expect(
      panel.querySelector(`[data-terminal-frame="${info.id}"]`),
    ).not.toHaveAttribute("data-waiting");
  });

  it("shows how full Claude's memory is under the active tab (option C)", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "agent");
    render(<App />);
    const panel = await openPanel(task.id);
    const tab = await within(panel).findByRole("tab", { name: "Claude Code" });
    const container = tab.parentElement as HTMLElement;
    // Nothing until the first reply measures it.
    expect(within(container).queryByTestId("context-thread")).toBeNull();

    // A long conversation: the line fills, the percentage stays, orange.
    await act(() =>
      commands.writeTerminal({ terminalId: info.id, data: "/c\r" }),
    );
    const thread = await within(container).findByTestId("context-thread");
    expect(thread.firstElementChild).toHaveStyle({ width: "86%" });
    const peek = within(container).getByTestId("context-peek");
    expect(peek).toHaveTextContent("86 %");
    expect(peek).toHaveClass("text-due-overdue");
    expect(tab).toHaveAccessibleName(
      "Claude Code, Mémoire de Claude : 86 % utilisée",
    );

    // Hovering the tab opens the details.
    await user.hover(tab);
    const bubble = await screen.findByTestId("context-bubble");
    expect(bubble).toHaveTextContent("Claude · Opus 5.5");
    expect(bubble).toHaveTextContent("860 k");
    expect(bubble).toHaveTextContent("sur 1 M");
    expect(bubble).toHaveTextContent("Reste140 k");
    expect(bubble).toHaveTextContent(
      "Claude va bientôt résumer la conversation",
    );
    await user.unhover(tab);
    await waitFor(() =>
      expect(screen.queryByTestId("context-bubble")).toBeNull(),
    );
  });

  it("keeps the red border on the Claude pane in focus mode", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "agent");
    const shell = await openRaw(task.id, "shell");
    await commands.writeTerminal({ terminalId: info.id, data: "/q\r" });
    render(<App />);
    const panel = await openPanel(task.id);
    act(() => useUi.getState().setFocusMode(true));
    const frame = await waitFor(() => {
      const el = panel.querySelector(`[data-terminal-frame="${info.id}"]`);
      if (!el) throw new Error("no Claude pane");
      return el as HTMLElement;
    });
    await waitFor(() => expect(frame).toHaveAttribute("data-waiting", "true"));
    expect(
      panel.querySelector(`[data-terminal-frame="${shell.id}"]`),
    ).not.toHaveAttribute("data-waiting");
    expect(
      within(panel).queryByRole("button", { name: "Répondre…" }),
    ).toBeNull();
  });
});

describe("quit and panes", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    setTerminalList([]);
  });
  afterEach(() => vi.restoreAllMocks());

  const term = (id: string, kind: TerminalInfo["kind"], running = true) =>
    ({
      id,
      taskId: "t",
      kind,
      command: null,
      cwd: "/x",
      openedAt: "2026-10-03T10:00:00Z",
      running,
      exitCode: null,
      agentSessionId: null,
      agent: null,
    }) satisfies TerminalInfo;

  it("quits at once when nothing runs", async () => {
    const quit = vi.spyOn(commands, "quitApp");
    setTerminalList([term("a", "shell", false)]);
    await requestQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("confirms with the number of sessions, then quits", async () => {
    const user = userEvent.setup();
    const quit = vi.spyOn(commands, "quitApp");
    render(<App />);
    setTerminalList([
      term("a", "agent"),
      term("b", "agent"),
      term("c", "shell"),
    ]);
    const pending = requestQuit();
    const dialog = await screen.findByRole("dialog", { name: "Quitter ?" });
    expect(dialog).toHaveTextContent(
      "2 sessions tournent encore. Quitter les met en pause.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Quitter" }));
    await pending;
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("confirms running shells too", async () => {
    const user = userEvent.setup();
    const quit = vi.spyOn(commands, "quitApp");
    render(<App />);
    setTerminalList([term("c", "shell")]);
    const pending = requestQuit();
    const dialog = await screen.findByRole("dialog", { name: "Quitter ?" });
    expect(dialog).toHaveTextContent(
      "1 terminal tourne encore. Quitter l'arrête.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    await pending;
    expect(quit).not.toHaveBeenCalled();
  });

  it("gives each terminal a pane, four at most, the first Claude terminal first", () => {
    const list = [term("s", "shell"), term("c", "agent"), term("d", "command")];
    expect(resolvePanes(list)).toEqual(["c", "s", "d"]);
    // A terminal chosen twice keeps its first place only.
    expect(resolvePanes(list, ["s", "s"])).toEqual(["s", "d", "c"]);
    expect(resolvePanes([term("c", "agent")])).toBeNull();
    const five = [...list, term("e", "shell"), term("f", "shell")];
    expect(resolvePanes(five)).toEqual(["c", "s", "d", "e"]);
  });

  it("keeps the panes in place when a terminal opens or closes", () => {
    const four = ["a", "b", "c", "d"];
    // A new terminal gets a pane of its own.
    expect(
      resolvePanes(
        [term("a", "agent"), term("b", "shell"), term("c", "shell")],
        ["a", "b"],
      ),
    ).toEqual(["a", "b", "c"]);
    // One pane less: the last pane's terminal takes the closed one's place.
    expect(
      resolvePanes(
        [term("a", "agent"), term("c", "shell"), term("d", "shell")],
        four,
      ),
    ).toEqual(["a", "d", "c"]);
    // Still four panes: a terminal no pane showed takes the place.
    expect(
      resolvePanes(
        [
          term("a", "agent"),
          term("c", "shell"),
          term("d", "shell"),
          term("e", "command"),
        ],
        four,
      ),
    ).toEqual(["a", "e", "c", "d"]);
  });

  it("moves the panes of focus mode through every terminal", () => {
    const list = [term("a", "agent"), term("b", "shell"), term("c", "command")];
    // Next one already in the other pane: the focus goes there.
    expect(cyclePanes(list, ["a", "b"], 0, 1)).toEqual({
      panes: ["a", "b"],
      pane: 1,
      focus: "b",
    });
    // Not shown: it replaces the focused pane's terminal.
    expect(cyclePanes(list, ["a", "b"], 1, 1)).toEqual({
      panes: ["a", "c"],
      pane: 1,
      focus: "c",
    });
    // Wraps around, backwards too.
    expect(cyclePanes(list, ["a", "b"], 0, -1)).toEqual({
      panes: ["c", "b"],
      pane: 0,
      focus: "c",
    });
    // Four panes: same rules.
    const five = [...list, term("d", "shell"), term("e", "shell")];
    expect(cyclePanes(five, ["a", "b", "c", "d"], 1, 1)).toEqual({
      panes: ["a", "b", "c", "d"],
      pane: 2,
      focus: "c",
    });
    expect(cyclePanes(five, ["a", "b", "c", "d"], 3, 1)).toEqual({
      panes: ["a", "b", "c", "e"],
      pane: 3,
      focus: "e",
    });
  });

  it("⌘⇧[ and ⌘⇧] move through the panes in focus mode, showing every terminal", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    await openRaw(task.id, "agent");
    await openRaw(task.id, "shell");
    await openRaw(task.id, "command", "npm test");
    await openRaw(task.id, "command", "npm run dev");
    await openRaw(task.id, "command", "git status");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", {
      name: "git status",
      selected: true,
    });
    act(() => useUi.getState().setFocusMode(true));
    // Four panes, the fourth under the first; the fifth terminal is in none: « +1 ».
    expect(paneHeader(panel, "en haut à gauche")).toHaveAccessibleName(
      "Terminal du volet en haut à gauche : Claude Code",
    );
    expect(paneHeader(panel, "en haut à droite")).toHaveAccessibleName(
      "Terminal du volet en haut à droite : Shell",
    );
    expect(paneHeader(panel, "en bas à droite")).toHaveAccessibleName(
      "Terminal du volet en bas à droite : npm test",
    );
    const bottomLeft = () => paneHeader(panel, "en bas à gauche");
    expect(bottomLeft()).toHaveAccessibleName(
      "Terminal du volet en bas à gauche : npm run dev",
    );
    expect(
      within(panel).getByRole("button", { name: "1 autre terminal" }),
    ).toBeInTheDocument();

    const next = () =>
      user.keyboard("{Meta>}{Shift>}[BracketRight]{/Shift}{/Meta}");
    const inPane = (n: number) =>
      panel
        .querySelector(`[data-pane="${n}"]`)
        ?.contains(document.activeElement);
    // From the first pane, through the panes in the order of the terminals.
    await next();
    await waitFor(() => expect(inPane(1)).toBe(true));
    await next();
    await waitFor(() => expect(inPane(2)).toBe(true));
    await next();
    await waitFor(() => expect(inPane(3)).toBe(true));
    // git status was in no pane: it replaces npm run dev, focused.
    await next();
    await waitFor(() =>
      expect(bottomLeft()).toHaveAccessibleName(
        "Terminal du volet en bas à gauche : git status",
      ),
    );
    await waitFor(() => expect(inPane(3)).toBe(true));
    // Wraps around to Claude, in the first pane.
    await next();
    await waitFor(() => expect(inPane(0)).toBe(true));
  });
});
