/**
 * Subtasks shown under their task in the lists (Todoist): indented rows with
 * their own checkbox, dot and due date, a chevron that folds them (remembered), a panel of
 * their own, and the keyboard walking through them.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { tomorrowString } from "../../lib/dates";
import { mockBackend } from "../../lib/ipc";
import { COLLAPSED_KEY, resetUi, useUi } from "../../stores/ui";
import { useCompletion } from "../task-row/actions";
import { resetList } from "./listStore";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const main = () => screen.getByRole("main");

/** A project with « Parent » (two subtasks, one due tomorrow, one done) and « Seule ». */
async function seed() {
  const c = backend().commands;
  const subject = await c.createSubject({
    name: "Globex",
    color: "pink",
    rootPath: null,
    parentId: null,
  });
  const base = {
    description: null,
    subjectId: subject.id,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  };
  const parent = await c.createTask({ ...base, title: "Parent" });
  const first = await c.addSubtask({ taskId: parent.id, text: "Première" });
  const second = await c.addSubtask({ taskId: parent.id, text: "Deuxième" });
  await c.setTaskDue({ id: first.id, date: tomorrowString(), time: null });
  await c.setTaskPriority({ id: first.id, priority: 3 });
  await c.toggleSubtask(second.id);
  const alone = await c.createTask({ ...base, title: "Seule" });
  useUi.getState().setView({ kind: "subject", subjectId: subject.id });
  return { subject, parent, first, second, alone };
}

const rowTitles = () =>
  Array.from(main().querySelectorAll("[data-task-list] [data-row-focus]")).map(
    (el) => el.textContent,
  );

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  resetList();
  useCompletion.setState({ phases: {} });
  useToasts.setState({ toasts: [] });
});

describe("subtasks in the lists", () => {
  it("shows them indented under their task, with their own checkbox and due date", async () => {
    const { parent } = await seed();
    render(<App />);
    const list = await within(main()).findByRole("list", {
      name: "Sous-tâches de « Parent »",
    });
    expect(rowTitles()).toEqual(["Parent", "Première", "Deuxième", "Seule"]);
    // The counter « faites/total » on the parent's line.
    const parentRow = main().querySelector(`[data-task-id="${parent.id}"]`);
    expect(parentRow).toHaveTextContent("1/2");
    // A child row: its priority on the checkbox, its due date, struck once done.
    const first = within(list).getByRole("button", {
      name: "Terminer · Priorité 2",
    });
    expect(first.querySelector("svg")).toHaveAttribute("data-priority", "3");
    expect(within(list).getByText("Demain")).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Deuxième" }).className,
    ).toContain("line-through");
    expect(list.className).toContain("ml-[30px]");
  });

  it("folds them with the chevron and remembers it", async () => {
    const user = userEvent.setup();
    const { parent } = await seed();
    const { unmount } = render(<App />);
    const chevron = await within(main()).findByRole("button", {
      name: "Masquer les sous-tâches de « Parent »",
    });
    await user.click(chevron);
    expect(
      within(main()).queryByRole("list", { name: "Sous-tâches de « Parent »" }),
    ).toBeNull();
    expect(rowTitles()).toEqual(["Parent", "Seule"]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]")).toEqual([
      parent.id,
    ]);
    // The keyboard skips folded subtasks.
    expect(useUi.getState().visibleTasks.map((t) => t.id)).not.toContain(
      (await backend().commands.getTask(parent.id)).subtasks[0].id,
    );
    unmount();
    // Still folded after a new start (the store reads `localStorage`).
    useUi.setState({ collapsedTasks: { [parent.id]: true } });
    render(<App />);
    expect(
      await within(main()).findByRole("button", {
        name: "Afficher les sous-tâches de « Parent »",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a subtask's own panel on click", async () => {
    const user = userEvent.setup();
    const { first } = await seed();
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Première" }),
    );
    expect(useUi.getState().openTaskId).toBe(first.id);
  });

  it("checks a subtask from its checkbox; it stays under its task, struck", async () => {
    const user = userEvent.setup();
    const { first, parent } = await seed();
    render(<App />);
    const list = await within(main()).findByRole("list", {
      name: "Sous-tâches de « Parent »",
    });
    await user.click(
      within(list).getByRole("button", { name: "Terminer · Priorité 2" }),
    );
    await waitFor(async () =>
      expect((await backend().commands.getTask(first.id)).completedAt).not.toBe(
        null,
      ),
    );
    await waitFor(() =>
      expect(
        main().querySelector(`[data-task-id="${parent.id}"]`),
      ).toHaveTextContent("2/2"),
    );
    expect(
      within(main()).getByRole("button", { name: "Première" }).className,
    ).toContain("line-through");
  });

  it("Space keeps the focus on a checked subtask, and moves it past a checked task's subtasks", async () => {
    const user = userEvent.setup();
    const { parent, alone } = await seed();
    render(<App />);
    await waitFor(() =>
      expect(rowTitles()).toEqual(["Parent", "Première", "Deuxième", "Seule"]),
    );
    const rowButton = (title: string) =>
      within(main()).getByRole("button", { name: title });
    // A subtask stays under its task, struck: the focus stays on it.
    rowButton("Première").focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(rowButton("Première").className).toContain("line-through"),
    );
    expect(rowButton("Première")).toHaveFocus();
    // The task leaves the list with its subtasks: the focus goes to the next task.
    rowButton("Parent").focus();
    await user.keyboard(" ");
    await waitFor(() => expect(rowTitles()).toEqual(["Seule"]));
    await waitFor(() => expect(rowButton("Seule")).toHaveFocus());
    expect(useUi.getState().selectedTaskId).toBe(alone.id);
    expect(
      (await backend().commands.getTask(parent.id)).subtasks.every(
        (s) => s.done,
      ),
    ).toBe(true);
  });

  it("walks through visible subtasks with the keyboard, → and ← fold", async () => {
    const user = userEvent.setup();
    const { parent, first } = await seed();
    render(<App />);
    const parentTitle = await within(main()).findByRole("button", {
      name: "Parent",
    });
    act(() => parentTitle.focus());
    await user.keyboard("{ArrowDown}");
    expect(
      within(main()).getByRole("button", { name: "Première" }),
    ).toHaveFocus();
    expect(useUi.getState().selectedTaskId).toBe(first.id);
    // ← on a subtask goes back to its task.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(parentTitle).toHaveFocus());
    // ← on an unfolded task folds it, → unfolds it.
    await user.keyboard("{ArrowLeft}");
    expect(useUi.getState().collapsedTasks[parent.id]).toBe(true);
    expect(rowTitles()).toEqual(["Parent", "Seule"]);
    await user.keyboard("{ArrowRight}");
    expect(rowTitles()).toEqual(["Parent", "Première", "Deuxième", "Seule"]);
    // The global ↑/↓ list includes the visible subtasks, in display order.
    expect(useUi.getState().visibleTasks.map((t) => t.id)).toHaveLength(4);
  });

  it("offers no « Déplacer » on a subtask row: it moves with its parent", async () => {
    const user = userEvent.setup();
    await seed();
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", {
        name: "Actions de la tâche Première",
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: /Déplacer/ }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitemcheckbox", { name: /Priorité 2/ }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("offers the four priorities in the row menu", async () => {
    const user = userEvent.setup();
    const { alone } = await seed();
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", {
        name: "Actions de la tâche Seule",
      }),
    );
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitemcheckbox", { name: /Priorité 1/ }),
    );
    await waitFor(async () =>
      expect((await backend().commands.getTask(alone.id)).priority).toBe(4),
    );
    await waitFor(() =>
      expect(
        within(main()).getByRole("button", { name: "Terminer · Priorité 1" }),
      ).toBeInTheDocument(),
    );
  });
});
