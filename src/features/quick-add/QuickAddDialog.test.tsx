import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { formatDue, todayString, tomorrowString } from "../../lib/dates";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { resetRegistry, setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { FOLDER } from "../terminals/testSupport";
import { openAddTaskForView } from "../views/addTarget";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function project(name: string, sections: string[] = [], rootPath = "") {
  const subject = await backend().commands.createSubject({
    name,
    color: null,
    rootPath: rootPath || null,
    parentId: null,
  });
  for (const section of sections) {
    await backend().commands.createSection({
      subjectId: subject.id,
      name: section,
      subpath: null,
    });
  }
  return subject;
}

/** Renders the app and opens the quick add with ⌘N. */
async function openQuickAdd() {
  const user = userEvent.setup();
  render(<App />);
  // Projects loaded first, so the parser knows them.
  await screen.findByRole("navigation", { name: "Navigation" });
  await user.keyboard("{Meta>}n{/Meta}");
  const dialog = await screen.findByRole("dialog", { name: "Nouvelle tâche" });
  const title = within(dialog).getByRole("combobox", {
    name: "Nom de la tâche",
  });
  await waitFor(() => expect(title).toHaveFocus());
  return { user, dialog, title };
}

const marks = (dialog: HTMLElement) =>
  Array.from(
    within(dialog).getByTestId("quick-add-highlight").querySelectorAll("mark"),
  ).map((m) => [m.dataset.token, m.textContent]);

const chips = (dialog: HTMLElement) =>
  within(dialog).getByRole("group", { name: "Ce que l'ajout va faire" });

describe("quick add dialog", () => {
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

  it("colours the tokens live, shows the chips and adds the task on Enter", async () => {
    const site = await project("Site", ["Design"]);
    await waitFor(() => expect(backend().state.subjects).toHaveLength(1));
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Maquette #Site/Design demain 17h");
    expect(marks(dialog)).toEqual([
      ["project", "#Site/Design"],
      ["date", "demain"],
      ["time", "17h"],
    ]);
    const due = formatDue({ date: tomorrowString(), time: "17:00" });
    expect(
      within(chips(dialog)).getByRole("button", {
        name: `Échéance : ${due}. Changer`,
      }),
    ).toBeInTheDocument();
    expect(
      within(chips(dialog)).getByRole("button", {
        name: "Destination : Site › Design. Changer",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "#projet · /section · @date · demain 17h · !2 · >claude · >codex",
      ),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    const task = backend().state.tasks[0];
    expect(task).toMatchObject({
      title: "Maquette",
      subjectId: site.id,
      dueDate: tomorrowString(),
      dueTime: "17:00",
    });
    expect(task.sectionId).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Nouvelle tâche" })).toBeNull();
  });

  it("prefills the project of the view, and today from Aujourd'hui", async () => {
    const site = await project("Site");
    act(() =>
      useUi.getState().setView({ kind: "subject", subjectId: site.id }),
    );
    const { dialog, user } = await openQuickAdd();
    expect(
      within(chips(dialog)).getByRole("button", {
        name: "Destination : Site. Changer",
      }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    act(() => useUi.getState().setView({ kind: "today", subjectId: null }));
    act(() => openAddTaskForView());
    const again = await screen.findByRole("dialog", { name: "Nouvelle tâche" });
    expect(
      within(chips(again)).getByRole("button", {
        name: "Échéance : Aujourd'hui. Changer",
      }),
    ).toBeInTheDocument();
  });

  it("turns a token back into text when its chip is removed", async () => {
    await project("Site");
    const { user, dialog, title } = await openQuickAdd();
    await user.type(title, "Appeler demain #Site");
    const due = formatDue({ date: tomorrowString(), time: null });

    await user.click(
      within(chips(dialog)).getByRole("button", { name: `Retirer : ${due}` }),
    );
    expect(marks(dialog)).toEqual([["project", "#Site"]]);
    expect(
      within(chips(dialog)).getByRole("button", { name: "Échéance" }),
    ).toBeInTheDocument();

    await user.click(
      within(chips(dialog)).getByRole("button", { name: "Retirer : Site" }),
    );
    expect(marks(dialog)).toEqual([]);
    expect(
      within(chips(dialog)).getByRole("button", {
        name: "Destination : Sans projet. Changer",
      }),
    ).toBeInTheDocument();

    // The text is left as typed; editing elsewhere keeps the tokens as text.
    expect(title).toHaveValue("Appeler demain #Site");
    await user.type(title, " vite");
    expect(marks(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Ajouter" }));
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Appeler demain #Site vite",
      subjectId: null,
      dueDate: null,
    });
  });

  it("completes # with the keyboard (listbox, arrows, Enter, Escape)", async () => {
    await project("Site", ["Design"]);
    await project("Perso");
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Faire #");
    const list = within(dialog).getByRole("listbox", {
      name: "Projets et sections",
    });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Site", "Perso"]);
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(title).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(title).toHaveAttribute("aria-activedescendant", options[1].id);
    await user.keyboard("{Enter}");
    expect(title).toHaveValue("Faire #Perso ");
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    expect(marks(dialog)).toEqual([["project", "#Perso"]]);
    // Enter picked; nothing was added.
    expect(backend().state.tasks).toHaveLength(0);

    // Sections of a project, then Escape closes the list but not the dialog.
    await user.type(title, "#site/");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Site › Design"]);
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Nouvelle tâche" })).toBe(dialog);
  });

  it("Enter adds over a loose or longer suggestion, unless chosen with the arrows", async () => {
    const ops = await project("Ops", ["Templates"]);
    await project("Site");
    await project("Site web");
    act(() => useUi.getState().setView({ kind: "subject", subjectId: ops.id }));
    const { user, dialog, title } = await openQuickAdd();

    // « /tmp » only matches « Templates » letter by letter: Enter adds the task.
    await user.type(title, "Nettoyer /tmp");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Templates"]);
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Nettoyer /tmp",
      sectionId: null,
    });

    await user.type(title, "Nettoyer /tmp");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(2));
    expect(backend().state.tasks[1].title).toBe("Nettoyer /tmp");
  });

  it("Enter after the arrows takes the loose suggestion; a complete name then a space closes the list", async () => {
    const ops = await project("Ops", ["Templates"]);
    await project("Site");
    await project("Site web");
    act(() => useUi.getState().setView({ kind: "subject", subjectId: ops.id }));
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Copier /tmp");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(title).toHaveValue("Copier /Templates ");
    expect(backend().state.tasks).toHaveLength(0);

    await user.clear(title);
    await user.type(title, "Corriger #Site ");
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({ title: "Corriger" });
  });

  it("does not offer the view's sections after an unknown project", async () => {
    const site = await project("Site", ["Design", "Dév"]);
    act(() =>
      useUi.getState().setView({ kind: "subject", subjectId: site.id }),
    );
    const { user, dialog, title } = await openQuickAdd();
    await user.type(title, "Bug /De");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Design", "Dév"]);
    await user.clear(title);
    await user.type(title, "Bug #Nouveau /De");
    expect(within(dialog).queryByRole("listbox")).toBeNull();
  });

  it("offers to create an unknown project, without folder", async () => {
    const { user, dialog, title } = await openQuickAdd();
    await user.type(title, "Relancer #Nouveau");
    expect(within(dialog).getByText(/Projet introuvable/)).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Créer « Nouveau » ?" }),
    );
    await waitFor(() =>
      expect(marks(dialog)).toEqual([["project", "#Nouveau"]]),
    );
    const created = backend().state.subjects.find((s) => s.name === "Nouveau");
    expect(created?.rootPath).toBeNull();
    expect(within(dialog).queryByText(/Projet introuvable/)).toBeNull();
    expect(title).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Relancer",
      subjectId: created?.id,
    });
  });

  it("« Ajouter et lancer » opens Claude without a first message, in the task panel", async () => {
    await project("Globex", [], FOLDER);
    const spy = vi.spyOn(commands, "openTerminal");
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Exporter le CSV >claude #Globex");
    expect(marks(dialog)).toEqual([
      ["agent", ">claude"],
      ["project", "#Globex"],
    ]);
    expect(
      within(chips(dialog)).getByRole("button", {
        name: "Retirer : Claude Code, ouvert à l'ajout",
      }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Ajouter et lancer" }),
    );

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const task = backend().state.tasks[0];
    expect(task.title).toBe("Exporter le CSV");
    expect(spy.mock.calls[0][0]).toMatchObject({
      taskId: task.id,
      kind: "agent",
      initialPrompt: null,
      addTaskContext: true,
    });
    expect(useUi.getState().openTaskId).toBe(task.id);
    expect(screen.queryByRole("dialog", { name: "Nouvelle tâche" })).toBeNull();
  });

  it(">shell opens a shell; removing the agent chip only adds", async () => {
    await project("Globex", [], FOLDER);
    const spy = vi.spyOn(commands, "openTerminal");
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Build >shell #Globex");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ kind: "shell" });
    expect(dialog).not.toBeInTheDocument();

    spy.mockClear();
    act(() => useUi.getState().openTask(null));
    act(() => openAddTaskForView());
    const again = await screen.findByRole("dialog", { name: "Nouvelle tâche" });
    const field = within(again).getByRole("combobox", {
      name: "Nom de la tâche",
    });
    await user.type(field, "Relire >claude");
    await user.click(
      await within(chips(again)).findByRole("button", {
        name: "Retirer : Claude Code, ouvert à l'ajout",
      }),
    );
    expect(
      within(again).getByRole("button", { name: "Ajouter" }),
    ).toBeEnabled();
    await user.click(within(again).getByRole("button", { name: "Ajouter" }));
    await waitFor(() => expect(backend().state.tasks).toHaveLength(2));
    expect(backend().state.tasks[1].title).toBe("Relire >claude");
    expect(spy).not.toHaveBeenCalled();
  });

  it("!1 shows a red P1 chip and sets the priority right after the add", async () => {
    const spy = vi.spyOn(commands, "setTaskPriority");
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Payer le loyer !1 !2");
    expect(marks(dialog)).toEqual([["priority", "!1"]]);
    const mark = within(dialog)
      .getByTestId("quick-add-highlight")
      .querySelector("mark");
    expect(mark?.style.color).toBe("var(--priority-4)");
    expect(
      within(chips(dialog)).getByRole("button", {
        name: "Retirer : Priorité 1",
      }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const task = backend().state.tasks[0];
    expect(spy).toHaveBeenCalledWith({ id: task.id, priority: 4 });
    expect(task).toMatchObject({ title: "Payer le loyer !2", priority: 4 });
  });

  it("removing the priority chip adds the task without a priority", async () => {
    const spy = vi.spyOn(commands, "setTaskPriority");
    const { user, dialog, title } = await openQuickAdd();

    await user.type(title, "Payer !1");
    await user.click(
      within(chips(dialog)).getByRole("button", {
        name: "Retirer : Priorité 1",
      }),
    );
    expect(marks(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Ajouter" }));
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Payer !1",
      priority: 1,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not set a priority when there is no token", async () => {
    const spy = vi.spyOn(commands, "setTaskPriority");
    const { user, title } = await openQuickAdd();
    await user.type(title, "Simple{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(spy).not.toHaveBeenCalled();
  });

  it("⌥Enter adds and keeps the dialog open; ↓ goes to the description", async () => {
    const { user, dialog, title } = await openQuickAdd();
    await user.type(title, "Premier 9h");
    await user.keyboard("{ArrowDown}");
    const description = within(dialog).getByRole("textbox", {
      name: "Description",
    });
    expect(description).toHaveFocus();
    await user.type(description, "Avec une note");
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    await waitFor(() => expect(backend().state.tasks).toHaveLength(1));
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Premier",
      description: "Avec une note",
      dueDate: todayString(),
      dueTime: "09:00",
    });
    expect(screen.getByRole("dialog", { name: "Nouvelle tâche" })).toBe(dialog);
    expect(title).toHaveValue("");
    expect(description).toHaveValue("");
    expect(title).toHaveFocus();

    await user.type(title, "Second{Enter}");
    await waitFor(() => expect(backend().state.tasks).toHaveLength(2));
    expect(screen.queryByRole("dialog", { name: "Nouvelle tâche" })).toBeNull();
  });
});
