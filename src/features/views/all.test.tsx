/**
 * « À faire » (`ViewKind::All`): first sidebar entry with ⌘1, one section per
 * project (dot, « Globex › Client » for a sub-project, a link to the project), « Sans projet »
 * at its place among the projects (last by default), add rows prefilled with their project,
 * subtasks nested, empty state; groups dragged by their header, rows with their own place.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { mockBackend } from "../../lib/ipc";
import { INITIAL_VIEW, resetUi, useUi } from "../../stores/ui";
import { useCompletion } from "../task-row/actions";
import { resetList } from "./listStore";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const nav = () => screen.getByRole("navigation", { name: "Navigation" });
const main = () => screen.getByRole("main");

const project = (name: string, parentId: string | null = null) => {
  // Taido V2.2 bis: only a group holds projects.
  const parent = backend().state.subjects.find((s) => s.id === parentId);
  if (parent) parent.isGroup = true;
  return backend().commands.createSubject({
    name,
    color: null,
    rootPath: null,
    parentId,
  });
};

const task = (title: string, subjectId: string | null) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

const group = (id: string) =>
  main().querySelector<HTMLElement>(`[data-group="${id}"]`);

async function findGroup(id: string) {
  return waitFor(() => {
    const el = group(id);
    if (!el) throw new Error(`no group ${id} yet`);
    return el;
  });
}

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  resetList();
  useCompletion.setState({ phases: {} });
  useToasts.setState({ toasts: [] });
});

describe("« À faire »", () => {
  it("opens from the sidebar, first, with ⌘1 shown at the right", async () => {
    await project("Globex");
    const user = userEvent.setup();
    render(<App />);
    const entry = await within(nav()).findByRole("button", {
      name: /^À faire/,
    });
    expect(entry).toHaveTextContent("À faire⌘1");
    expect(entry).toHaveAttribute("title", "À faire (⌘1)");
    // Right above « Aujourd'hui », first of the transverse views.
    const items = within(nav())
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    const today = items.findIndex((t) => t.startsWith("Aujourd'hui"));
    expect(items[today - 1]).toBe("À faire⌘1");
    await user.click(entry);
    expect(useUi.getState().view).toEqual({ kind: "all", subjectId: null });
    expect(entry).toHaveAttribute("aria-current", "page");
    expect(
      await within(main()).findByRole("heading", { level: 1, name: "À faire" }),
    ).toBeInTheDocument();
  });

  it("opens with ⌘1", async () => {
    await project("Globex");
    render(<App />);
    await within(nav()).findByRole("button", { name: /^Globex/ });
    fireEvent.keyDown(document.body, {
      key: "1",
      code: "Digit1",
      metaKey: true,
    });
    expect(useUi.getState().view.kind).toBe("all");
    expect(
      await within(main()).findByRole("heading", { level: 1, name: "À faire" }),
    ).toBeInTheDocument();
  });

  it("shows one section per project, named with its group, « Sans projet » last", async () => {
    // Taido V2.2 bis: Globex is a group (no tasks, no section of its own).
    const globex = await project("Globex");
    const client = await project("Client", globex.id);
    const perso = await project("Perso");
    await project("Vide");
    await task("Maquette", client.id);
    const parent = await task("Passeport", perso.id);
    await backend().commands.addSubtask({
      taskId: parent.id,
      text: "Photo d'identité",
    });
    await task("Raycast", null);
    useUi.getState().setView({ kind: "all", subjectId: null });
    const user = userEvent.setup();
    render(<App />);
    await findGroup(`project:${client.id}`);
    const sections = Array.from(
      main().querySelectorAll<HTMLElement>("[data-group]"),
    );
    expect(sections.map((s) => s.dataset.group)).toEqual([
      `project:${client.id}`,
      `project:${perso.id}`,
      "no_project",
    ]);
    expect(
      sections.map(
        (s) => within(s).getByRole("heading", { level: 2 }).textContent,
      ),
    ).toEqual(["Globex › Client", "Perso", "Sans projet"]);
    expect(within(main()).getByText("3 tâches")).toBeInTheDocument();
    // The project's colour dot; rows never repeat the project.
    const clientSection = sections[0];
    expect(
      clientSection.querySelector("h2 span[aria-hidden='true']"),
    ).not.toBeNull();
    expect(within(clientSection).getByText("Maquette")).toBeInTheDocument();
    expect(within(clientSection).queryByText("# Client")).toBeNull();
    // Subtasks nested under their task.
    expect(
      within(sections[1]).getByText("Photo d'identité"),
    ).toBeInTheDocument();

    // The section title opens the project.
    await user.click(
      within(clientSection).getByRole("button", { name: "Globex › Client" }),
    );
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: client.id,
    });
  });

  it("adds a task to a project from its section's add row", async () => {
    const globex = await project("Globex");
    await task("Facture", globex.id);
    await task("Raycast", null);
    useUi.getState().setView({ kind: "all", subjectId: null });
    const user = userEvent.setup();
    render(<App />);
    const section = await findGroup(`project:${globex.id}`);
    await user.click(within(section).getByRole("button", { name: "Ajouter…" }));
    const editor = section.querySelector<HTMLElement>("[data-task-editor]");
    expect(editor).not.toBeNull();
    await user.type(
      within(editor as HTMLElement).getByRole("textbox", {
        name: "Nom de la tâche",
      }),
      "Relancer le client{Enter}",
    );
    await waitFor(() =>
      expect(
        within(section).getByText("Relancer le client"),
      ).toBeInTheDocument(),
    );
    const created = backend().state.tasks.find(
      (t) => t.title === "Relancer le client",
    );
    expect(created?.subjectId).toBe(globex.id);
    // « Sans projet » adds without project.
    const loose = await findGroup("no_project");
    await user.click(within(loose).getByRole("button", { name: "Ajouter…" }));
    const looseEditor = loose.querySelector<HTMLElement>("[data-task-editor]");
    await user.type(
      within(looseEditor as HTMLElement).getByRole("textbox", {
        name: "Nom de la tâche",
      }),
      "Lire{Enter}",
    );
    await waitFor(() =>
      expect(
        backend().state.tasks.find((t) => t.title === "Lire")?.subjectId,
      ).toBeNull(),
    );
  });

  it("says when there is nothing to do", async () => {
    await project("Globex");
    useUi.getState().setView({ kind: "all", subjectId: null });
    render(<App />);
    expect(await within(main()).findByText("Rien à faire")).toBeInTheDocument();
    expect(main().querySelector("[data-group]")).toBeNull();
  });

  it("puts « Sans projet » at its place among the projects", async () => {
    const globex = await project("Globex");
    const client = await project("Client", globex.id);
    const perso = await project("Perso");
    await task("Maquette", client.id);
    await task("Passeport", perso.id);
    await task("Raycast", null);
    useUi.getState().setView({ kind: "all", subjectId: null });
    render(<App />);
    await findGroup("no_project");
    const ids = () =>
      Array.from(main().querySelectorAll<HTMLElement>("[data-group]")).map(
        (s) => s.dataset.group,
      );
    // Moved after the Globex group: after its projects too, like in the sidebar.
    await backend().commands.reorderInbox(1);
    await waitFor(() =>
      expect(ids()).toEqual([
        `project:${client.id}`,
        "no_project",
        `project:${perso.id}`,
      ]),
    );
    await backend().commands.reorderInbox(0);
    await waitFor(() =>
      expect(ids()).toEqual([
        "no_project",
        `project:${client.id}`,
        `project:${perso.id}`,
      ]),
    );
  });

  it("drags project groups by their header, never by the keyboard", async () => {
    const globex = await project("Globex");
    await task("Facture", globex.id);
    await task("Raycast", null);
    useUi.getState().setView({ kind: "all", subjectId: null });
    render(<App />);
    for (const id of [`project:${globex.id}`, "no_project"]) {
      const header = (await findGroup(id)).querySelector("header");
      expect(header).toHaveClass("drag-header");
      // Pointer only: no extra tab stop nor dnd-kit button role on the header.
      expect(header).not.toHaveAttribute("tabindex");
      expect(header).not.toHaveAttribute("role");
    }
  });

  it("reorders a row with ⌥↑ / ⌥↓ within its own section", async () => {
    const globex = await project("Globex");
    const devis = await backend().commands.createSection({
      subjectId: globex.id,
      name: "Devis",
      subpath: null,
    });
    await task("A", globex.id);
    await task("B", globex.id);
    await backend().commands.createTask({
      title: "C",
      description: null,
      subjectId: globex.id,
      sectionId: devis.id,
      dueDate: null,
      dueTime: null,
    });
    useUi.getState().setView({ kind: "all", subjectId: null });
    const user = userEvent.setup();
    render(<App />);
    const section = await findGroup(`project:${globex.id}`);
    const titles = () =>
      within(section)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("[data-row-focus]")?.textContent);
    expect(titles()).toEqual(["A", "B", "C"]);
    within(section).getByRole("button", { name: "A" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(titles()).toEqual(["B", "A", "C"]));
    // Last of the tasks outside sections: ⌥↓ does not enter « Devis ».
    await waitFor(() =>
      expect(within(section).getByRole("button", { name: "A" })).toHaveFocus(),
    );
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    within(section).getByRole("button", { name: "C" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(titles()).toEqual(["B", "A", "C"]));
    expect(
      backend().state.tasks.find((t) => t.title === "A")?.sectionId,
    ).toBeNull();
    expect(backend().state.tasks.find((t) => t.title === "C")?.sectionId).toBe(
      devis.id,
    );
  });

  it("is the view the app opens on", () => {
    expect(INITIAL_VIEW).toEqual({ kind: "all", subjectId: null });
  });
});
