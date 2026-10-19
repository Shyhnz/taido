import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { SessionSummary } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { commands } from "../../lib/ipc";
import { AGENT_DELAYS, MOCK_QUESTION } from "../../lib/mock-sessions";
import { resetUi, useUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "./fakeXterm";
import { resetRegistry, setXtermFactory } from "./registry";
import { recapSource, sessionRecap } from "./SessionHistory";
import { setTerminalList } from "./terminalList";
import { backend, openRaw, taskWithFolder } from "./testSupport";

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await screen.findByRole("region", {
    name: "Panneau de la tâche",
  });
  await within(panel).findByRole("textbox", { name: "Titre de la tâche" });
  return panel;
}

const type = (terminalId: string, data: string) =>
  backend().commands.writeTerminal({ terminalId, data });

/** The « Conversations passées » section of the panel and its fold button. */
async function historySection(panel: HTMLElement) {
  const section = await within(panel).findByRole("region", {
    name: "Conversations passées",
  });
  const toggle = within(section).getByRole("button", {
    name: /^Conversations passées/,
  });
  return { section, toggle };
}

const queryHistory = (panel: HTMLElement) =>
  within(panel).queryByRole("region", { name: "Conversations passées" });

/** The « Conversations passées » list of the panel, unfolded first when needed. */
async function history(panel: HTMLElement) {
  const { section, toggle } = await historySection(panel);
  if (toggle.getAttribute("aria-expanded") === "false") {
    act(() => toggle.click());
  }
  return within(section).getByRole("list");
}

describe("« Conversations passées » history", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
    useToasts.setState({ toasts: [] });
    window.localStorage.clear();
    // The simulated Haiku recap would replace the recap mid-test: tested on its own below.
    backend().state.settings.summarizeSessions = false;
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("is hidden while the task has no Claude session", async () => {
    const task = await taskWithFolder();
    await openRaw(task.id, "shell");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Shell" });
    expect(queryHistory(panel)).toBeNull();
  });

  it("does not list a conversation its tab shows, lists it once the process ended", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "Sur quelle tâche je suis ?\r");
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("tab", { name: "Claude Code" });
    // Running in a tab: the tab is the place to see it, no « Aller à l'onglet ».
    expect(queryHistory(panel)).toBeNull();

    await act(() => type(term.id, "/exit\r"));
    // The tab stays (exited) but the conversation is now history, folded.
    const { toggle } = await historySection(panel);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Layout C: the folded row ends with how many there are.
    expect(toggle).toHaveTextContent(/^Conversations passées\s*1$/);
    const row = within(await history(panel)).getByRole("listitem");
    expect(row).toHaveTextContent("Sur quelle tâche je suis ?");
    expect(
      within(row).queryByRole("button", { name: /Aller à l'onglet/ }),
    ).toBeNull();
  });

  it("resumes an ended session in a new tab", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "bonjour\r");
    await type(term.id, "/exit\r");
    await commands.closeTerminal(term.id);
    const spy = vi.spyOn(commands, "resumeSession");
    render(<App />);
    const panel = await openPanel(task.id);
    // Nothing runs: folded by default.
    const { toggle } = await historySection(panel);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(panel).queryByText(/bonjour/)).toBeNull();
    const row = within(await history(panel)).getByRole("listitem");
    expect(row).toHaveTextContent("moins d'1 min");
    // No reply yet: the recap is the first message alone.
    expect(row.querySelector('[data-part="recap"]')).toHaveTextContent(
      /^bonjour$/,
    );
    expect(row).not.toHaveTextContent("arrêtée brutalement");

    await user.click(within(row).getByRole("button", { name: /Reprendre/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      agentSessionId: term.agentSessionId,
    });
    // The conversation is back in a new tab, active, running.
    await within(panel).findByRole("tab", { name: "Claude Code" });
    const active = useUi.getState().activeTerminals[task.id];
    expect(active).toBeDefined();
    expect(active).not.toBe(term.id);
    // Running again in a tab: no longer listed.
    await waitFor(() => expect(queryHistory(panel)).toBeNull());
  });

  it("marks a crash and keeps it resumable", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "lance les tests\r");
    await type(term.id, "/x\r");
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    expect(row).toHaveTextContent("arrêtée brutalement");
    expect(
      within(row).getByRole("button", { name: /Reprendre/ }),
    ).toBeInTheDocument();
  });

  it("hides an ended conversation without message", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "/exit\r");
    await commands.closeTerminal(term.id);
    render(<App />);
    const panel = await openPanel(task.id);
    await within(panel).findByRole("textbox", { name: "Note" });
    expect(queryHistory(panel)).toBeNull();
  });

  it("recaps a session in one sentence: first message → last reply", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "bonjour\r");
    await type(term.id, "/q\r");
    await type(term.id, "/exit\r");
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    expect(row.querySelector('[data-part="recap"]')).toHaveTextContent(
      "bonjour → J'ai fini l'analyse du job.",
    );
    // date · duration in small text below.
    expect(row.querySelector('[data-part="meta"]')).toHaveTextContent(
      /^aujourd'hui \d\d:\d\d · moins d'1 min$/,
    );
    // The recap describes the row's button.
    expect(
      within(row).getByRole("button", { name: /Voir les échanges/ }),
    ).toHaveAccessibleDescription("bonjour → J'ai fini l'analyse du job.");
  });

  it("folds and unfolds the section with its title", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "bonjour\r");
    await type(term.id, "/exit\r");
    render(<App />);
    const panel = await openPanel(task.id);
    const { section, toggle } = await historySection(panel);
    // Folded by default (option A).
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(section).queryByRole("list")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(section).getByRole("list")).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("unfolds the exchanges of a session", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "bonjour\r");
    // `/q` ends the turn at once with a question (no timer to wait for).
    await type(term.id, "/q\r");
    await type(term.id, "/e\r");
    await type(term.id, "/exit\r");
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    const toggle = within(row).getByRole("button", {
      name: /Voir les échanges/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const items = await within(row).findAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-kind"))).toEqual([
      "prompt",
      "reply",
      "error",
    ]);
    expect(items[0]).toHaveTextContent("Toi");
    expect(items[0]).toHaveTextContent("bonjour");
    expect(items[1]).toHaveTextContent("Claude");
    expect(items[1]).toHaveTextContent(MOCK_QUESTION);
    expect(items[2]).toHaveTextContent("Limite d'usage atteinte");
  });

  it("clamps a long reply with « Voir plus »", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, `${"très long message ".repeat(40)}\r`);
    await type(term.id, "/exit\r");
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    await user.click(
      within(row).getByRole("button", { name: /Voir les échanges/ }),
    );
    const more = await within(row).findByRole("button", { name: "Voir plus" });
    await user.click(more);
    expect(
      within(row).getByRole("button", { name: "Voir moins" }),
    ).toBeInTheDocument();
  });

  it("lists the conversations newest first, /clear included", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "première\r");
    await type(term.id, "/clear\r");
    await type(term.id, "seconde\r");
    render(<App />);
    const panel = await openPanel(task.id);
    // The second conversation runs in the tab: only the first is history.
    let rows = within(await history(panel)).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("première");

    await act(() => type(term.id, "/exit\r"));
    const { section } = await historySection(panel);
    const items = () =>
      within(within(section).getByRole("list")).getAllByRole("listitem");
    await waitFor(() => expect(items()).toHaveLength(2));
    rows = items();
    expect(rows[0]).toHaveTextContent("seconde");
    expect(rows[1]).toHaveTextContent("première");
  });
});

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  id: "s",
  agent: "claude",
  state: "paused",
  terminalId: null,
  startedAt: "2026-10-03T10:00:00.000Z",
  endedAt: "2026-10-03T10:05:00.000Z",
  firstPrompt: "bonjour",
  promptCount: 1,
  crashed: false,
  resumable: true,
  lastReply: "Salut.",
  title: null,
  aiSummary: null,
  ...over,
});

describe("session recap: title, Claude Haiku, fallback (option 4)", () => {
  it("prefers the user's title, then Haiku's summary, then the trace", () => {
    const both = summary({ title: "Mon titre", aiSummary: "Résumé IA" });
    expect(sessionRecap(both)).toBe("Mon titre");
    expect(recapSource(both)).toBe("title");
    const ai = summary({ aiSummary: "Résumé IA" });
    expect(sessionRecap(ai)).toBe("Résumé IA");
    expect(recapSource(ai)).toBe("ai");
    const plain = summary({});
    expect(sessionRecap(plain)).toBe("bonjour → Salut.");
    expect(recapSource(plain)).toBe("fallback");
  });
});

describe("« Conversations passées »: Haiku recap and rename", () => {
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

  /** An ended session with one message; Haiku's simulated recap arrives later. */
  async function endedSession() {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await type(term.id, "bonjour\r");
    await type(term.id, "/exit\r");
    await commands.closeTerminal(term.id);
    return { task, term };
  }

  it("shows Haiku's recap with its marker once the session ended", async () => {
    const { task } = await endedSession();
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    await waitFor(
      () =>
        expect(row.querySelector('[data-part="recap"]')).toHaveTextContent(
          "Résumé simulé : bonjour",
        ),
      { timeout: AGENT_DELAYS.summary + 2000 },
    );
    expect(row.querySelector('[data-part="recap"]')).toHaveAttribute(
      "data-source",
      "ai",
    );
    const marker = row.querySelector('[data-part="ai-marker"]');
    expect(marker).toHaveAttribute("title", "Résumé par Claude");
  });

  it("renames with Entrée, cancels with Échap, and an empty title restores the recap", async () => {
    backend().state.settings.summarizeSessions = false;
    const user = userEvent.setup();
    const { task } = await endedSession();
    const spy = vi.spyOn(commands, "renameSession");
    render(<App />);
    const panel = await openPanel(task.id);
    const row = within(await history(panel)).getByRole("listitem");
    const recap = () => row.querySelector('[data-part="recap"]');
    expect(recap()).toHaveTextContent(/^bonjour$/);

    // Échap: nothing saved.
    await user.click(
      within(row).getByRole("button", { name: "Renommer la session" }),
    );
    let field = within(row).getByRole("textbox", { name: /Nom de la session/ });
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("maxLength", "120");
    await user.clear(field);
    await user.type(field, "Ne pas garder{Escape}");
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(recap()).toHaveTextContent(/^bonjour$/);

    // Entrée: the title replaces the recap, without the Haiku marker.
    await user.click(
      within(row).getByRole("button", { name: "Renommer la session" }),
    );
    field = within(row).getByRole("textbox", { name: /Nom de la session/ });
    await user.clear(field);
    await user.type(field, "Export des prestataires{Enter}");
    await waitFor(() =>
      expect(recap()).toHaveTextContent("Export des prestataires"),
    );
    expect(recap()).toHaveAttribute("data-source", "title");
    expect(row.querySelector('[data-part="ai-marker"]')).toBeNull();
    expect(spy).toHaveBeenLastCalledWith({
      agentSessionId: expect.any(String),
      title: "Export des prestataires",
    });

    // Double click edits too; empty goes back to the automatic recap.
    await user.dblClick(recap() as HTMLElement);
    field = within(row).getByRole("textbox", { name: /Nom de la session/ });
    await user.clear(field);
    await user.type(field, "{Enter}");
    await waitFor(() => expect(recap()).toHaveTextContent(/^bonjour$/));
    expect(spy).toHaveBeenLastCalledWith({
      agentSessionId: expect.any(String),
      title: "",
    });
  });

  it("no recap from Haiku when the setting is off", async () => {
    backend().state.settings.summarizeSessions = false;
    const { task } = await endedSession();
    await new Promise((r) => setTimeout(r, AGENT_DELAYS.summary + 100));
    const [s] = await commands.listTaskSessions(task.id);
    expect(s.aiSummary).toBeNull();
  });
});
