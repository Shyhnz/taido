/** In the task panel: child tasks, priority, Claude's state dot. */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { runningTerminals, setTerminalList } from "../terminals/terminalList";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function createTask(title: string, rootPath: string | null = null) {
  const subject = rootPath
    ? await backend().commands.createSubject({
        name: "Globex",
        color: null,
        rootPath,
        parentId: null,
      })
    : null;
  return backend().commands.createTask({
    title,
    description: null,
    subjectId: subject?.id ?? null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

const panelRegion = () =>
  screen.findByRole("region", { name: "Panneau de la tâche" });

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await panelRegion();
  await within(panel).findByRole("textbox", { name: "Titre de la tâche" });
  return panel;
}

/** The panel once it shows the given title. */
async function panelShowing(title: string) {
  const panel = await panelRegion();
  await waitFor(() =>
    expect(
      within(panel).getByRole("textbox", { name: "Titre de la tâche" }),
    ).toHaveValue(title),
  );
  return panel;
}

describe("task panel: subtasks, priority and state dot", () => {
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

  describe("subtasks are child tasks", () => {
    it("opens a subtask's panel from its text, and comes back by the breadcrumb", async () => {
      const user = userEvent.setup();
      const parent = await createTask("Préparer la démo");
      const child = await backend().commands.addSubtask({
        taskId: parent.id,
        text: "Écrire le script",
      });
      render(<App />);
      const panel = await openPanel(parent.id);
      await user.click(
        within(panel).getByRole("button", {
          name: "Ouvrir la sous-tâche « Écrire le script »",
        }),
      );
      expect(useUi.getState().openTaskId).toBe(child.id);
      const childPanel = await panelShowing("Écrire le script");
      // A task panel like any other, without « Sous-tâches » (one level).
      expect(
        within(childPanel).queryByRole("heading", { name: /^Sous-tâches/ }),
      ).toBeNull();
      expect(
        within(childPanel).getByRole("textbox", { name: "Note" }),
      ).toBeInTheDocument();
      expect(
        within(childPanel).getByRole("button", { name: "Échéance" }),
      ).toBeInTheDocument();
      expect(
        within(childPanel).getByRole("button", {
          name: "Priorité : P4. Changer",
        }),
      ).toBeInTheDocument();
      expect(
        within(childPanel).getByRole("button", { name: /Lancer Claude Code/ }),
      ).toBeInTheDocument();
      // It lives where its parent does: no move of its own.
      expect(
        within(childPanel).queryByRole("button", { name: /^Projet : / }),
      ).toBeNull();
      expect(
        childPanel.querySelector('[data-chip="location"]'),
      ).toHaveTextContent("Sans projet");
      await user.click(
        within(childPanel).getByRole("button", {
          name: "Plus d'actions sur la tâche",
        }),
      );
      const more = await screen.findByRole("menu");
      expect(
        within(more).queryByRole("menuitem", { name: "Déplacer vers…" }),
      ).toBeNull();
      await user.keyboard("{Escape}");

      await user.click(
        within(childPanel).getByRole("button", {
          name: "Revenir à « Préparer la démo »",
        }),
      );
      expect(useUi.getState().openTaskId).toBe(parent.id);
      const back = await panelShowing("Préparer la démo");
      expect(
        within(back).queryByRole("button", { name: /Revenir à/ }),
      ).toBeNull();
      expect(
        within(back).getByRole("heading", { name: /^Sous-tâches/ }),
      ).toBeInTheDocument();
    });

    it("shows the priority ring, due date and Claude's dot on a subtask line", async () => {
      const parent = await createTask("Livrer", "/Users/user/Projets/globex");
      const child = await backend().commands.addSubtask({
        taskId: parent.id,
        text: "Relire",
      });
      await backend().commands.setTaskPriority({ id: child.id, priority: 3 });
      await backend().commands.setTaskDue({
        id: child.id,
        date: "2020-01-02",
        time: null,
      });
      // A Claude running in the subtask (its own terminals).
      const term = await commands.openTerminal({
        taskId: child.id,
        kind: "agent",
        agent: null,
        command: null,
        initialPrompt: null,
        permissionMode: null,
        addTaskContext: null,
        cols: 80,
        rows: 24,
      });
      await commands.writeTerminal({ terminalId: term.id, data: "/q\r" });
      render(<App />);
      const panel = await openPanel(parent.id);
      const line = await waitFor(() => {
        const li = panel.querySelector<HTMLElement>(
          `[data-subtask-id="${child.id}"]`,
        );
        if (!li) throw new Error("no subtask line");
        return li;
      });
      const check = within(line).getByRole("checkbox", { name: "Relire" });
      expect(check.querySelector("svg")).toHaveAttribute("data-priority", "3");
      await waitFor(() =>
        expect(line.querySelector("[data-state-dot]")).toHaveAttribute(
          "data-state-dot",
          "waiting",
        ),
      );
      // Overdue date in brick orange.
      const due = within(line).getByTitle(/^Échéance : /);
      expect(due).toHaveClass("text-due-overdue");
    });

    it("toggles a subtask with its ring without opening it", async () => {
      const user = userEvent.setup();
      const parent = await createTask("Avec enfants");
      const child = await backend().commands.addSubtask({
        taskId: parent.id,
        text: "Volumes",
      });
      render(<App />);
      const panel = await openPanel(parent.id);
      await user.click(
        within(panel).getByRole("checkbox", { name: "Volumes" }),
      );
      await waitFor(() =>
        expect(
          within(panel).getByRole("checkbox", { name: "Volumes" }),
        ).toHaveAttribute("aria-checked", "true"),
      );
      expect(useUi.getState().openTaskId).toBe(parent.id);
      const detail = await backend().commands.getTask(child.id);
      expect(detail.completedAt).not.toBeNull();
    });

    it("renames a subtask inline, Escape leaves the panel open", async () => {
      const user = userEvent.setup();
      const parent = await createTask("Parent");
      const child = await backend().commands.addSubtask({
        taskId: parent.id,
        text: "Brouillon",
      });
      render(<App />);
      const panel = await openPanel(parent.id);
      await user.click(
        within(panel).getByRole("button", {
          name: "Renommer la sous-tâche · Brouillon",
        }),
      );
      const field = within(panel).getByRole("textbox", {
        name: "Texte de la sous-tâche",
      });
      expect(field).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(await panelRegion()).toBeInTheDocument();
      expect(
        within(panel).queryByRole("textbox", {
          name: "Texte de la sous-tâche",
        }),
      ).toBeNull();

      await user.click(
        within(panel).getByRole("button", {
          name: "Renommer la sous-tâche · Brouillon",
        }),
      );
      const again = within(panel).getByRole("textbox", {
        name: "Texte de la sous-tâche",
      });
      await user.clear(again);
      await user.type(again, "Version finale{Enter}");
      await waitFor(async () =>
        expect((await backend().commands.getTask(child.id)).title).toBe(
          "Version finale",
        ),
      );
      expect(
        await within(panel).findByRole("button", {
          name: "Ouvrir la sous-tâche « Version finale »",
        }),
      ).toBeInTheDocument();
    });

    it("asks before stopping a Claude that runs in a subtask", async () => {
      const user = userEvent.setup();
      const parent = await createTask("Livrer", "/Users/user/Projets/globex");
      const child = await backend().commands.addSubtask({
        taskId: parent.id,
        text: "Relire",
      });
      await commands.openTerminal({
        taskId: child.id,
        kind: "agent",
        agent: null,
        command: null,
        initialPrompt: null,
        permissionMode: null,
        addTaskContext: null,
        cols: 80,
        rows: 24,
      });
      render(<App />);
      const panel = await openPanel(parent.id);
      await waitFor(() =>
        expect(runningTerminals().map((t) => t.taskId)).toEqual([child.id]),
      );
      const cancelDialog = async () => {
        const dialog = await screen.findByRole("dialog", {
          name: "Une session tourne sur cette tâche",
        });
        await user.click(
          within(dialog).getByRole("button", { name: "Annuler" }),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      };
      const isOpen = async (id: string) =>
        (await backend().commands.getTask(id)).completedAt === null;

      // Checking the subtask from the parent's panel.
      await user.click(within(panel).getByRole("checkbox", { name: "Relire" }));
      await cancelDialog();
      expect(await isOpen(child.id)).toBe(true);
      // Checking the parent: the core would close its subtasks' terminals too.
      await user.click(within(panel).getByRole("button", { name: "Terminer" }));
      await cancelDialog();
      expect(await isOpen(parent.id)).toBe(true);
      // Deleting the subtask asks too; confirming deletes it.
      await user.click(
        within(panel).getByRole("button", {
          name: "Supprimer la sous-tâche · Relire",
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Une session tourne sur cette tâche",
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Supprimer la tâche" }),
      );
      await waitFor(async () =>
        expect((await backend().commands.getTask(parent.id)).subtasks).toEqual(
          [],
        ),
      );
    });

    it("deletes a subtask from its line", async () => {
      const user = userEvent.setup();
      const parent = await createTask("Parent");
      await backend().commands.addSubtask({ taskId: parent.id, text: "Jeter" });
      render(<App />);
      const panel = await openPanel(parent.id);
      await user.click(
        within(panel).getByRole("button", {
          name: "Supprimer la sous-tâche · Jeter",
        }),
      );
      await waitFor(() =>
        expect(within(panel).queryByText("Jeter")).toBeNull(),
      );
      expect((await backend().commands.getTask(parent.id)).subtasks).toEqual(
        [],
      );
    });
  });

  describe("priority", () => {
    it("picks a priority from the chip", async () => {
      const user = userEvent.setup();
      const task = await createTask("Urgent");
      const spy = vi.spyOn(commands, "setTaskPriority");
      render(<App />);
      const panel = await openPanel(task.id);
      const ring = within(panel).getByRole("button", { name: "Terminer" });
      expect(ring.querySelector("svg")).toHaveAttribute("data-priority", "1");

      await user.click(
        within(panel).getByRole("button", { name: "Priorité : P4. Changer" }),
      );
      const menu = await screen.findByRole("menu", { name: "Priorité" });
      expect(
        within(menu)
          .getAllByRole("menuitemcheckbox")
          .map((el) => el.textContent),
      ).toEqual([
        // P1, the most urgent (red), first, like Todoist.
        "Priorité 1P1",
        "Priorité 2P2",
        "Priorité 3P3",
        "Priorité 4P4",
      ]);
      expect(
        within(menu).getByRole("menuitemcheckbox", { name: /Priorité 4/ }),
      ).toHaveAttribute("aria-checked", "true");
      await user.click(
        within(menu).getByRole("menuitemcheckbox", { name: /Priorité 2/ }),
      );
      // P2 is the stored 3.
      expect(spy).toHaveBeenCalledWith({ id: task.id, priority: 3 });
      expect(
        await within(panel).findByRole("button", {
          name: "Priorité : P2. Changer",
        }),
      ).toBeInTheDocument();
      // The title ring follows: orange outline, « Terminer · Priorité 2 ».
      expect(
        within(panel)
          .getByRole("button", { name: "Terminer · Priorité 2" })
          .querySelector("svg"),
      ).toHaveAttribute("data-priority", "3");
    });

    it("sets the priority from the ⋯ menu", async () => {
      const user = userEvent.setup();
      const task = await createTask("Par le menu");
      render(<App />);
      const panel = await openPanel(task.id);
      await user.click(
        within(panel).getByRole("button", {
          name: "Plus d'actions sur la tâche",
        }),
      );
      const more = await screen.findByRole("menu", {
        name: "Plus d'actions sur la tâche",
      });
      await user.click(
        within(more).getByRole("menuitem", { name: /Priorité…/ }),
      );
      const menu = await screen.findByRole("menu", { name: "Priorité" });
      await user.click(
        within(menu).getByRole("menuitemcheckbox", { name: /Priorité 1/ }),
      );
      await waitFor(async () =>
        expect((await backend().commands.getTask(task.id)).priority).toBe(4),
      );
      expect(
        await within(panel).findByRole("button", {
          name: "Priorité : P1. Changer",
        }),
      ).toBeInTheDocument();
    });

    it("completes the task with the priority ring", async () => {
      const user = userEvent.setup();
      const task = await createTask("À cocher");
      await backend().commands.setTaskPriority({ id: task.id, priority: 2 });
      render(<App />);
      const panel = await openPanel(task.id);
      await user.click(
        within(panel).getByRole("button", { name: "Terminer · Priorité 3" }),
      );
      const reopen = await within(panel).findByRole("button", {
        name: "Rouvrir",
      });
      expect(reopen.querySelector("svg")).toHaveAttribute(
        "data-completed",
        "true",
      );
    });
  });

  describe("Claude's state dot by the title", () => {
    it("shows no dot for a plain task, a dot while Claude runs", async () => {
      const task = await createTask("Avec Claude", "/Users/user/Projets/x");
      render(<App />);
      const panel = await openPanel(task.id);
      const title = within(panel).getByRole("textbox", {
        name: "Titre de la tâche",
      });
      const row = title.parentElement;
      if (!row) throw new Error("no title row");
      expect(row.querySelector("[data-state-dot]")).toBeNull();

      const term = await act(() =>
        commands.openTerminal({
          taskId: task.id,
          kind: "agent",
          agent: null,
          command: null,
          initialPrompt: null,
          permissionMode: null,
          addTaskContext: null,
          cols: 80,
          rows: 24,
        }),
      );
      await act(() =>
        commands.writeTerminal({ terminalId: term.id, data: "/e\r" }),
      );
      await waitFor(() =>
        expect(row.querySelector("[data-state-dot]")).toHaveAttribute(
          "data-state-dot",
          "error",
        ),
      );
      // The ring keeps telling the priority only.
      expect(
        within(panel).getByRole("button", { name: "Terminer" }),
      ).toBeInTheDocument();
    });
  });
});
