/**
 * First-launch guide in the app, on the mock backend: when it
 * shows, the whole tour driven by what the user does, leaving, resuming, replaying.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { resetUi } from "../../stores/ui";
import { resetClaudeCheck } from "../claude-check/claudeCheck";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { backend } from "../terminals/testSupport";
import { useTutorial } from "./store";

const t = fr.tutorial;

/** The bubble or card of a step, by its title. */
const step = (name: string, timeout = 1000) =>
  screen.findByRole("dialog", { name }, { timeout });

async function createProject(name: string) {
  return backend().commands.createSubject({
    name,
    color: null,
    rootPath: null,
    parentId: null,
  });
}

describe("first-launch guide", () => {
  beforeEach(() => {
    // Ending a guide of the previous test saves « done »: before the reset.
    useTutorial.setState({ run: null });
    backend().reset({ seed: false });
    backend().state.settings.tutorial.status = "not_started";
    resetUi();
    resetClaudeCheck();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    useTutorial.setState({ run: null });
    resetRegistry();
    setXtermFactory(null);
    vi.restoreAllMocks();
  });

  it("is offered to an empty app; « Non merci » ends it for good", async () => {
    const user = userEvent.setup();
    render(<App />);
    const card = await step(t.welcome.title(fr.appName));
    expect(card).toHaveTextContent(t.welcome.ask);
    // The three colours of Claude's dot, in an example list.
    expect(within(card).getByLabelText("Claude travaille")).toBeInTheDocument();
    expect(
      within(card).getByLabelText("Claude attend ta réponse"),
    ).toBeInTheDocument();
    expect(backend().state.settings.tutorial.status).toBe("in_progress");

    await user.click(within(card).getByRole("button", { name: "Non merci" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend().state.settings.tutorial).toMatchObject({
      status: "done",
      step: null,
    });
    expect(useToasts.getState().toasts.at(-1)?.message).toBe(t.left);
  });

  it("asks which AI first, then names it in the guide", async () => {
    const user = userEvent.setup();
    backend().state.settings.agentChosen = false;
    backend().state.claude = { found: false, loggedIn: null };
    render(<App />);
    const card = await step(t.agent.title);
    // Only Codex is ready: it is chosen already.
    const codex = await within(card).findByRole("radio", { name: /Codex/ });
    await waitFor(() => expect(codex).toBeChecked());
    expect(card).toHaveTextContent("npm install -g @anthropic-ai/claude-code");
    await user.click(within(card).getByRole("button", { name: t.agent.next }));
    await waitFor(() =>
      expect(backend().state.settings).toMatchObject({
        defaultAgent: "codex",
        agentChosen: true,
      }),
    );
    const welcome = await step(t.welcome.title(fr.appName));
    expect(
      within(welcome).getByLabelText("Codex travaille"),
    ).toBeInTheDocument();
  });

  it("keeps the choice when the tour is declined, and « plus tard » keeps Claude", async () => {
    const user = userEvent.setup();
    backend().state.settings.agentChosen = false;
    render(<App />);
    const card = await step(t.agent.title);
    await user.click(within(card).getByRole("button", { name: t.agent.later }));
    await waitFor(() =>
      expect(backend().state.settings).toMatchObject({
        defaultAgent: "claude",
        agentChosen: true,
      }),
    );
    const welcome = await step(t.welcome.title(fr.appName));
    await user.click(
      within(welcome).getByRole("button", { name: "Non merci" }),
    );
    expect(backend().state.settings.agentChosen).toBe(true);
  });

  it("does not ask again once the AI is chosen", async () => {
    render(<App />);
    await step(t.welcome.title(fr.appName));
    expect(screen.queryByRole("dialog", { name: t.agent.title })).toBeNull();
  });

  it("never shows by itself in an app that already has data", async () => {
    await createProject("Perso");
    render(<App />);
    await waitFor(() =>
      expect(backend().state.settings.tutorial.status).toBe("done"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("walks through the whole tour as the user does each thing", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      within(await step(t.welcome.title(fr.appName))).getByRole("button", {
        name: t.welcome.start,
      }),
    );

    // 1. The project line is already open in the sidebar.
    const project = await step(t.project.title);
    expect(project).toHaveTextContent(t.stepOf(1, 9));
    const name = screen.getByRole("textbox", { name: "Nom du nouveau projet" });
    await waitFor(() => expect(name).toHaveFocus());
    await user.type(name, "Perso{Enter}");

    // 2. The project opens with its add line.
    await step(t.task.title);
    const main = screen.getByRole("main");
    const title = await within(main).findByLabelText("Nom de la tâche");
    await waitFor(() => expect(title).toHaveFocus());
    await user.type(title, "Essayer Claude{Enter}");

    // 3. The bubble points at the new row.
    await step(t.open.title);
    await user.keyboard("{Escape}");
    await user.click(
      within(main).getByRole("button", { name: "Essayer Claude" }),
    );

    // 4. Claude Code is checked, then launched from the panel.
    const claude = await step(t.claude.title);
    expect(claude).toHaveTextContent(t.stepOf(4, 9));
    await within(claude).findByText(t.claude.ready);
    await user.click(
      screen.getByRole("button", { name: /Lancer Claude Code/ }),
    );

    // Then what to write, and each colour of the dot: same step, same number.
    await waitFor(() =>
      expect(
        document.querySelector('[data-tutorial-bubble="talk"]'),
      ).not.toBeNull(),
    );
    const talk = await step(t.talk.title);
    expect(talk).toHaveTextContent(t.stepOf(4, 9));
    expect(talk).toHaveTextContent(t.talk.prompt);
    const task = backend().state.tasks.find(
      (x) => x.title === "Essayer Claude",
    );
    const terminal = backend().terminals.forTask(task?.id ?? "")[0];
    backend().terminals.write(terminal.id, `${t.talk.prompt}\r`);
    await waitFor(() => expect(talk).toHaveTextContent(t.talk.working));
    await waitFor(() => expect(talk).toHaveTextContent(t.talk.done), {
      timeout: 4000,
    });
    expect(talk).toHaveTextContent(t.talk.noRed);
    await user.click(within(talk).getByRole("button", { name: t.talk.next }));

    // 5. The kanban: the bubble points at its tab, then at the card.
    const kanban = await step(t.kanban.title);
    expect(kanban).toHaveTextContent(t.stepOf(5, 9));
    expect(kanban).toHaveTextContent("« Essayer Claude »");
    const tab = screen.getByRole("tab", { name: fr.board.board });
    expect(tab).toHaveAttribute("data-tutorial", "board-tab");
    await user.click(tab);
    const subjectId = task?.subjectId ?? null;
    const board = await backend().commands.getBoard(subjectId);
    // Launching Claude already put the card « En cours » (core rule): only a move counts.
    expect(board.columns[1].cards.map((c) => c.id)).toEqual([task?.id]);
    await waitFor(() =>
      expect(
        document.querySelector(`[data-card="${task?.id}"]`),
      ).not.toBeNull(),
    );
    const bubble = screen.getByRole("dialog", { name: t.kanban.title });
    expect(bubble).toBeVisible();
    // The text says so and asks for the next column.
    await waitFor(() =>
      expect(bubble).toHaveTextContent(t.kanban.already(board.columns[1].name)),
    );
    expect(bubble).toHaveTextContent(`« ${board.columns[2].name} »`);
    await backend().commands.moveTaskToColumn({
      taskId: task?.id ?? "",
      columnId: board.columns[2].id,
    });

    // 6. A file on the task, in its open panel.
    const file = await step(t.file.title);
    expect(file).toHaveTextContent(t.stepOf(6, 9));
    await backend().commands.addAttachments({
      taskId: task?.id ?? "",
      paths: ["/Users/user/maquette.png"],
    });

    // 7. ⌘N with the project's name.
    const quick = await step(t.quickAdd.title);
    expect(quick).toHaveTextContent("#Perso");
    await user.keyboard("{Meta>}n{/Meta}");
    const field = await screen.findByLabelText(fr.quickAdd.titleLabel);
    await user.type(field, "Appeler le client{Enter}");

    // 8. Check the guide's task, back in the list: its running Claude asks first.
    const complete = await step(t.complete.title);
    expect(complete).toHaveTextContent(t.stepOf(8, 9));
    const row = document.querySelector(`[data-task-id="${task?.id}"]`);
    if (!(row instanceof HTMLElement)) throw new Error("row not shown");
    await user.click(within(row).getByRole("button", { name: /^Terminer/ }));
    const confirm = await screen.findByRole("dialog", {
      name: fr.terminals.stopSessionsTitle(1),
    });
    // The bubble steps aside for the confirmation.
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: t.complete.title }),
      ).toBeNull(),
    );
    await user.click(
      within(confirm).getByRole("button", {
        name: fr.terminals.completeConfirm,
      }),
    );

    // 9. The account, then the closing card.
    const account = await step(t.account.title, 4000);
    expect(account).toHaveTextContent(t.stepOf(9, 9));
    expect(account).toHaveTextContent(t.account.text);
    await user.click(
      within(account).getByRole("button", { name: t.account.later }),
    );
    const done = await step(t.done.title);
    expect(done).toHaveTextContent("⌘K");
    expect(done).toHaveTextContent(t.done.more.title);
    for (const item of t.done.more.items) expect(done).toHaveTextContent(item);
    await user.click(within(done).getByRole("button", { name: t.done.finish }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend().state.settings.tutorial.status).toBe("done");
  }, 20_000);

  it("skips a step, and leaves from any bubble", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: t.welcome.start }),
    );
    const project = await step(t.project.title);
    await user.click(within(project).getByRole("button", { name: t.skip }));
    const task = await step(t.task.title);
    expect(task).toHaveTextContent(t.stepOf(2, 9));
    await user.click(within(task).getByRole("button", { name: t.quit }));
    expect(screen.queryByRole("dialog", { name: t.task.title })).toBeNull();
    expect(backend().state.settings.tutorial.status).toBe("done");
  });

  it("resumes where the previous launch stopped", async () => {
    const subject = await createProject("Perso");
    backend().state.settings.tutorial = {
      status: "in_progress",
      step: "quickAdd",
      subjectId: subject.id,
      taskId: null,
    };
    render(<App />);
    expect(await step(t.quickAdd.title)).toHaveTextContent(t.stepOf(7, 9));
  });

  it("resumes a step of the first guide at the nearest one", async () => {
    const subject = await createProject("Perso");
    backend().state.settings.tutorial = {
      status: "in_progress",
      step: "phone",
      subjectId: subject.id,
      taskId: null,
    };
    render(<App />);
    expect(await step(t.account.title)).toHaveTextContent(t.stepOf(9, 9));
  });

  it("drops the card on « Terminé »: the kanban step ends and « Coche » is skipped", async () => {
    const user = userEvent.setup();
    const subject = await createProject("Perso");
    const created = await backend().commands.createTask({
      title: "Essayer Claude",
      description: null,
      subjectId: subject.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    backend().state.settings.tutorial = {
      status: "in_progress",
      step: "kanban",
      subjectId: subject.id,
      taskId: created.id,
    };
    render(<App />);
    await step(t.kanban.title);
    await user.click(screen.getByRole("tab", { name: fr.board.board }));
    await waitFor(() =>
      expect(
        document.querySelector(`[data-card="${created.id}"]`),
      ).not.toBeNull(),
    );
    const board = await backend().commands.getBoard(subject.id);
    await backend().commands.moveTaskToColumn({
      taskId: created.id,
      columnId: board.columns[3].id,
    });
    const file = await step(t.file.title);
    await user.click(within(file).getByRole("button", { name: t.skip }));
    const quick = await step(t.quickAdd.title);
    await user.click(within(quick).getByRole("button", { name: t.skip }));
    await step(t.account.title);
  });

  it("says when an account is already linked", async () => {
    const user = userEvent.setup();
    const subject = await createProject("Perso");
    await backend().sync.signup({
      serverUrl: "https://taido.example",
      email: "user@example.com",
      password: "un mot de passe solide",
    });
    backend().state.settings.tutorial = {
      status: "in_progress",
      step: "account",
      subjectId: subject.id,
      taskId: null,
    };
    render(<App />);
    const account = await step(t.account.title);
    await within(account).findByText(t.account.linked);
    expect(
      within(account).queryByRole("button", { name: t.account.open }),
    ).toBeNull();
    await user.click(
      within(account).getByRole("button", { name: t.account.next }),
    );
    await step(t.done.title);
  });

  it("explains a missing Claude Code and lets the Claude part be skipped", async () => {
    const user = userEvent.setup();
    const subject = await createProject("Perso");
    const created = await backend().commands.createTask({
      title: "Essayer Claude",
      description: null,
      subjectId: subject.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    backend().state.claude = { found: false, loggedIn: null };
    backend().state.settings.tutorial = {
      status: "in_progress",
      step: "claude",
      subjectId: subject.id,
      taskId: created.id,
    };
    render(<App />);
    const claude = await step(t.claude.title);
    await within(claude).findByText(t.claude.missing);
    // Still missing after « Réessayer ».
    await user.click(
      within(claude).getByRole("button", { name: t.claude.retry }),
    );
    await within(claude).findByText(t.claude.missing);
    await user.click(
      within(claude).getByRole("button", { name: t.claude.skipPart }),
    );
    await step(t.kanban.title);
  });

  it("starts again from « Revoir le guide » in Réglages", async () => {
    const user = userEvent.setup();
    await createProject("Perso");
    backend().state.settings.tutorial.status = "done";
    render(<App />);
    await user.keyboard("{Meta>},{/Meta}");
    const settings = await screen.findByRole("dialog", { name: "Réglages" });
    await user.click(within(settings).getByRole("button", { name: t.replay }));
    expect(await step(t.welcome.title(fr.appName))).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Réglages" })).toBeNull();
  });
});
