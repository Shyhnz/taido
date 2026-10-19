import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { AgentStatus } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { commands } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { launchAgent, resumeSession } from "../terminals/actions";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { backend, openRaw, taskWithFolder } from "../terminals/testSupport";
import { claudeProblem, resetClaudeCheck } from "./claudeCheck";

describe("Claude Code check before the first Claude terminal", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetClaudeCheck();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("tells the problem from the status", () => {
    const found = { path: "/bin/claude", version: "2.1.288" };
    expect(claudeProblem({ ...found, loggedIn: true })).toBeNull();
    // `claude auth status` unreadable: Claude's own screen will tell.
    expect(claudeProblem({ ...found, loggedIn: null })).toBeNull();
    expect(claudeProblem({ ...found, loggedIn: false })).toBe("notLoggedIn");
    expect(claudeProblem({ path: null, version: null, loggedIn: null })).toBe(
      "missing",
    );
  });

  it("checks once per app run, then launches straight away", async () => {
    const task = await taskWithFolder();
    const check = vi.spyOn(commands, "checkAgent");
    const open = vi.spyOn(commands, "openTerminal");
    render(<App />);
    const first = await act(() => launchAgent(task.id));
    expect(first?.kind).toBe("agent");
    const second = await act(() => launchAgent(task.id));
    expect(second?.kind).toBe("agent");
    expect(check).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shares one check between two quick launches", async () => {
    const task = await taskWithFolder();
    const check = vi.spyOn(commands, "checkAgent");
    render(<App />);
    await act(() => Promise.all([launchAgent(task.id), launchAgent(task.id)]));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("explains a missing Claude Code, then launches after « Réessayer »", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    backend().state.claude = { found: false, loggedIn: null };
    const open = vi.spyOn(commands, "openTerminal");
    render(<App />);
    const launch = launchAgent(task.id);
    const dialog = await screen.findByRole("dialog", {
      name: "Claude Code introuvable",
    });
    expect(dialog).toHaveTextContent(
      "npm install -g @anthropic-ai/claude-code",
    );
    expect(dialog).toHaveTextContent("Réglages › Agents");
    expect(open).not.toHaveBeenCalled();

    // Still missing: the dialog stays and says so.
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    expect(
      await within(dialog).findByText("Toujours introuvable."),
    ).toBeInTheDocument();

    backend().state.claude = { found: true, loggedIn: true };
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    const info = await launch;
    expect(info?.kind).toBe("agent");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByRole("tab", { name: "Claude Code" }),
    ).toBeInTheDocument();
  });

  it("explains a logged-out Claude Code and opens the settings on demand", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    backend().state.claude = { found: true, loggedIn: false };
    const open = vi.spyOn(commands, "openTerminal");
    render(<App />);
    act(() => useUi.getState().openTask(task.id));
    await user.keyboard("{Meta>}t{/Meta}");
    const dialog = await screen.findByRole("dialog", {
      name: "Claude Code n'est pas connecté",
    });
    expect(dialog).toHaveTextContent(
      "Lance claude dans un terminal et connecte-toi",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Ouvrir les réglages" }),
    );
    const settings = await screen.findByRole("dialog", { name: "Réglages" });
    expect(
      within(settings).getByRole("tab", {
        name: "Agents",
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("a « Réessayer » still running does not close the settings opened meanwhile", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    backend().state.claude = { found: false, loggedIn: null };
    const open = vi.spyOn(commands, "openTerminal");
    render(<App />);
    const launch = launchAgent(task.id);
    const dialog = await screen.findByRole("dialog", {
      name: "Claude Code introuvable",
    });
    // The retried check answers only once the settings are open.
    let answer: (status: AgentStatus) => void = () => {};
    vi.spyOn(commands, "checkAgent").mockReturnValueOnce(
      new Promise<AgentStatus>((resolve) => {
        answer = resolve;
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Ouvrir les réglages" }),
    );
    await screen.findByRole("dialog", { name: "Réglages" });
    expect(await launch).toBeUndefined();

    await act(async () => {
      answer({ path: "/bin/claude", version: "2.1.288", loggedIn: true });
    });
    expect(
      screen.getByRole("dialog", { name: "Réglages" }),
    ).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("cancels the launch with Échap, and checks again next time", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    backend().state.claude = { found: false, loggedIn: null };
    const check = vi.spyOn(commands, "checkAgent");
    render(<App />);
    const launch = launchAgent(task.id);
    await screen.findByRole("dialog", { name: "Claude Code introuvable" });
    await user.keyboard("{Escape}");
    expect(await launch).toBeUndefined();
    expect(await commands.listTerminals()).toEqual([]);

    backend().state.claude = { found: true, loggedIn: true };
    expect((await act(() => launchAgent(task.id)))?.kind).toBe("agent");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("gates « Reprendre » too", async () => {
    const task = await taskWithFolder();
    const term = await openRaw(task.id, "agent");
    await commands.writeTerminal({ terminalId: term.id, data: "bonjour\r" });
    await commands.closeTerminal(term.id);
    backend().state.claude = { found: true, loggedIn: false };
    const resume = vi.spyOn(commands, "resumeSession");
    render(<App />);
    const pending = resumeSession(task.id, term.agentSessionId ?? "");
    await screen.findByRole("dialog", {
      name: "Claude Code n'est pas connecté",
    });
    expect(resume).not.toHaveBeenCalled();
    act(() => useUi.getState().closeDialog());
    expect(await pending).toBeUndefined();
  });

  it("lets the launch go on when the check itself fails", async () => {
    const task = await taskWithFolder();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(commands, "checkAgent").mockRejectedValue({
      kind: "internal",
      message: "boom",
    });
    render(<App />);
    expect((await act(() => launchAgent(task.id)))?.kind).toBe("agent");
  });

  it("keeps the claude_missing error of the launch, and checks again after it", async () => {
    const task = await taskWithFolder();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const check = vi.spyOn(commands, "checkAgent");
    render(<App />);
    expect((await act(() => launchAgent(task.id)))?.kind).toBe("agent");

    // The binary disappears after a successful check: the launch reports it.
    backend().state.claude = { found: false, loggedIn: null };
    vi.spyOn(commands, "checkAgent").mockResolvedValueOnce({
      path: "/opt/homebrew/bin/claude",
      version: "2.1.288",
      loggedIn: true,
    });
    resetClaudeCheck();
    expect(await act(() => launchAgent(task.id))).toBeUndefined();
    await waitFor(() =>
      expect(useToasts.getState().toasts.at(-1)?.message).toBe(
        "Impossible d'ouvrir le terminal. Claude Code est introuvable. Installe-le ou indique son chemin dans Réglages.",
      ),
    );
    // Next launch checks again and explains.
    const launch = launchAgent(task.id);
    expect(
      await screen.findByRole("dialog", { name: "Claude Code introuvable" }),
    ).toBeInTheDocument();
    act(() => useUi.getState().closeDialog());
    expect(await launch).toBeUndefined();
    expect(check).toHaveBeenCalled();
  });

  it("checks Codex, not Claude, when Codex is the default", async () => {
    const user = userEvent.setup();
    const task = await taskWithFolder();
    backend().state.settings.defaultAgent = "codex";
    backend().state.codex = { found: false, loggedIn: null };
    const check = vi.spyOn(commands, "checkAgent");
    const open = vi.spyOn(commands, "openTerminal");
    render(<App />);
    const launch = launchAgent(task.id);
    const dialog = await screen.findByRole("dialog", {
      name: "Codex introuvable",
    });
    expect(dialog).toHaveTextContent("npm install -g @openai/codex");
    expect(dialog).toHaveTextContent("Réglages › Agents");
    expect(check).toHaveBeenCalledWith("codex");
    expect(open).not.toHaveBeenCalled();

    backend().state.codex = { found: true, loggedIn: true };
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    const info = await launch;
    expect(info?.agent).toBe("codex");
    expect(open.mock.calls[0][0]).toMatchObject({ agent: "codex" });
    expect(
      await screen.findByRole("tab", { name: "Codex" }),
    ).toBeInTheDocument();
  });

  it("explains a logged-out Codex with its own command", async () => {
    const task = await taskWithFolder();
    backend().state.codex = { found: true, loggedIn: false };
    render(<App />);
    void launchAgent(task.id, "codex");
    const dialog = await screen.findByRole("dialog", {
      name: "Codex n'est pas connecté",
    });
    expect(dialog).toHaveTextContent("codex login");
  });

  it("checks Codex again when it went away after a successful check", async () => {
    const task = await taskWithFolder();
    backend().state.settings.defaultAgent = "codex";
    render(<App />);
    expect((await act(() => launchAgent(task.id)))?.agent).toBe("codex");
    backend().state.codex = { found: false, loggedIn: null };
    // The check passed: this launch fails in the core, the next one checks again.
    await act(() => launchAgent(task.id));
    void launchAgent(task.id);
    expect(
      await screen.findByRole("dialog", { name: "Codex introuvable" }),
    ).toBeInTheDocument();
  });
});
