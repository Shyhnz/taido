/**
 * Sidebar projects: inline creation, first launch, in-place rename, add a
 * section, delete with confirmation and undo, loading and error states.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { Subject } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { isFirstLaunch } from "../first-launch/FirstLaunch";
import { nextProjectColor, useProjectRename } from "./subjectActions";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const nav = () => screen.getByRole("navigation", { name: "Navigation" });
const main = () => screen.getByRole("main");

async function seedProject(name = "Globex") {
  return backend().commands.createSubject({
    name,
    color: "violet",
    rootPath: null,
    parentId: null,
  });
}

async function addTask(subjectId: string | null, title: string) {
  return backend().commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

async function openProjectMenu(name: string) {
  const user = userEvent.setup();
  await within(nav()).findByRole("button", { name: new RegExp(`^${name}`) });
  await user.click(
    within(nav()).getByRole("button", { name: `Actions du projet ${name}` }),
  );
  return { user, menu: await screen.findByRole("menu") };
}

describe("Sidebar projects", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useProjectRename.setState({ renamingId: null });
    useToasts.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the first-launch state with a dashed line when there is no project", async () => {
    render(<App />);
    expect(
      await within(main()).findByRole("heading", {
        name: "Commence par un projet",
      }),
    ).toBeInTheDocument();
    const dashed = await within(nav()).findByRole("button", {
      name: "Crée ton premier projet",
    });
    expect(dashed).toHaveClass("border-dashed");
    expect(
      within(nav()).queryByRole("button", { name: "Nouveau projet" }),
    ).toBeNull();
    // « Nouvelle tâche » stays visible even with no project (D2).
    expect(
      screen.getByRole("button", { name: /Nouvelle tâche/ }),
    ).toBeInTheDocument();

    await userEvent.setup().click(dashed);
    expect(
      screen.getByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toHaveFocus();
  });

  it("creates a project in place with Enter, opens it and asks for the add-task focus", async () => {
    await seedProject();
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await within(nav()).findByRole("button", { name: "Nouveau projet" }),
    );
    const input = screen.getByRole("textbox", {
      name: "Nom du nouveau projet",
    });
    expect(input).toHaveFocus();
    expect(screen.getByText("↵ créer · Échap annuler")).toBeInTheDocument();
    await user.type(input, "  Client Dupont {Enter}");

    expect(
      await within(main()).findByRole("heading", {
        level: 1,
        name: /Client Dupont/,
      }),
    ).toBeInTheDocument();
    const created = backend().state.subjects.find(
      (s) => s.name === "Client Dupont",
    );
    expect(created).toMatchObject({ color: "teal", rootPath: null });
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: created?.id,
    });
    // The project opens with the cursor in its add-task line.
    await waitFor(() =>
      expect(
        within(main()).getByRole("textbox", { name: "Nom de la tâche" }),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toBeNull();
  });

  it("cancels the inline creation with Escape or an empty name", async () => {
    await seedProject();
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await within(nav()).findByRole("button", { name: "Nouveau projet" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Nom du nouveau projet" }),
      "Brouillon{Escape}",
    );
    expect(
      screen.queryByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toBeNull();

    await user.click(
      within(nav()).getByRole("button", { name: "Nouveau projet" }),
    );
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toBeNull();
    expect(backend().state.subjects).toHaveLength(1);
  });

  it("opens the inline creation from the store action (⌘⇧N)", async () => {
    await seedProject();
    render(<App />);
    await within(nav()).findByRole("button", { name: /^Globex/ });
    act(() => useUi.getState().startNewProject());
    expect(
      screen.getByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toHaveFocus();
  });

  it("renames a project in place from its menu", async () => {
    await seedProject();
    render(<App />);
    const { user, menu } = await openProjectMenu("Globex");
    await user.click(within(menu).getByRole("menuitem", { name: "Renommer" }));
    const input = await screen.findByRole("textbox", {
      name: "Nouveau nom du projet Globex",
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("Globex");
    await user.clear(input);
    await user.type(input, "Globex 2{Enter}");
    expect(
      await within(nav()).findByRole("button", { name: /^Globex 2/ }),
    ).toBeInTheDocument();
    expect(backend().state.subjects[0].name).toBe("Globex 2");
  });

  it("keeps the name when the rename is cancelled with Escape", async () => {
    await seedProject();
    render(<App />);
    const { user, menu } = await openProjectMenu("Globex");
    await user.click(within(menu).getByRole("menuitem", { name: "Renommer" }));
    const input = await screen.findByRole("textbox", {
      name: "Nouveau nom du projet Globex",
    });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "XYZ{Escape}");
    expect(
      await within(nav()).findByRole("button", { name: /^Globex/ }),
    ).toBeInTheDocument();
    expect(backend().state.subjects[0].name).toBe("Globex");
  });

  it("adds a section from the project menu", async () => {
    const subject = await seedProject();
    render(<App />);
    const { user, menu } = await openProjectMenu("Globex");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Ajouter une section" }),
    );
    // The project opens with its in-place « Nouvelle section » field.
    await user.type(
      await within(main()).findByLabelText("Nom de la section"),
      "Recette{Enter}",
    );
    await waitFor(() =>
      expect(backend().state.sections.map((s) => s.name)).toEqual(["Recette"]),
    );
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: subject.id,
    });
  });

  it("deletes a project after an explicit confirmation and restores it with Annuler", async () => {
    const subject = await seedProject();
    await addTask(subject.id, "Relancer la DSI");
    await addTask(subject.id, "Facturer");
    useUi.getState().setView({ kind: "subject", subjectId: subject.id });
    render(<App />);
    const { user, menu } = await openProjectMenu("Globex");
    await user.click(within(menu).getByRole("menuitem", { name: "Supprimer" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Supprimer « Globex » ?",
    });
    expect(dialog).toHaveTextContent("2 tâches en cours");
    await user.click(
      within(dialog).getByRole("button", { name: "Supprimer le projet" }),
    );

    await waitFor(() =>
      expect(
        within(nav()).queryByRole("button", { name: /^Globex/ }),
      ).toBeNull(),
    );
    expect(useUi.getState().view.kind).toBe("today");
    const toast = (
      await screen.findByText("Projet « Globex » supprimé")
    ).closest<HTMLElement>('[role="status"]');
    if (!toast) throw new Error("no toast");

    await user.click(within(toast).getByRole("button", { name: "Annuler" }));
    expect(
      await within(nav()).findByRole("button", { name: /^Globex/ }),
    ).toHaveTextContent("2");
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: subject.id,
    });
  });

  it("does nothing when the deletion is not confirmed", async () => {
    await seedProject();
    render(<App />);
    const { user, menu } = await openProjectMenu("Globex");
    await user.click(within(menu).getByRole("menuitem", { name: "Supprimer" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(backend().state.subjects[0].deletedAt).toBeNull();
  });

  it("offers to link a folder in the project menu", async () => {
    await seedProject();
    render(<App />);
    const { menu } = await openProjectMenu("Globex");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual([
      "Renommer",
      "Couleur›",
      "Ajouter une section",
      // Taido V2.2 bis: groups replace sub-projects (« Retirer du groupe » only in a group).
      "Ajouter à un groupe›",
      "Relier à un dossier…",
      "Supprimer",
    ]);
  });

  it("shows « Projets indisponibles » with Réessayer when the list fails", async () => {
    await seedProject();
    const real = commands.listSubjects;
    const spy = vi
      .spyOn(commands, "listSubjects")
      .mockRejectedValueOnce({ kind: "internal", message: "db locked" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    expect(
      await within(nav()).findByText("Projets indisponibles"),
    ).toBeInTheDocument();
    // An error is never mistaken for « no project ».
    expect(
      within(nav()).queryByRole("button", { name: "Crée ton premier projet" }),
    ).toBeNull();
    expect(
      within(main()).queryByRole("heading", { name: "Commence par un projet" }),
    ).toBeNull();

    spy.mockImplementation(real);
    await userEvent
      .setup()
      .click(within(nav()).getByRole("button", { name: "Réessayer" }));
    expect(
      await within(nav()).findByRole("button", { name: /^Globex/ }),
    ).toBeInTheDocument();
  });

  it("shows a skeleton only when the list takes more than 150 ms", async () => {
    let resolve: (value: Subject[]) => void = () => {};
    vi.spyOn(commands, "listSubjects").mockImplementation(
      () =>
        new Promise<Subject[]>((r) => {
          resolve = r;
        }),
    );
    render(<App />);
    const status = within(nav()).getByRole("status", {
      name: "Chargement des projets",
    });
    expect(within(status).queryAllByTestId("project-skeleton")).toHaveLength(0);
    expect(
      await within(status).findAllByTestId("project-skeleton"),
    ).toHaveLength(3);
    act(() => resolve([]));
    expect(
      await within(nav()).findByRole("button", {
        name: "Crée ton premier projet",
      }),
    ).toBeInTheDocument();
  });
});

describe("project helpers", () => {
  const subject = (color: Subject["color"]): Subject => ({
    id: color,
    name: color,
    color,
    rootPath: null,
    position: null,
    sections: [],
    openCount: 0,
    dot: null,
    parentId: null,
    isGroup: false,
  });

  it("picks the first unused color, then the one after the last project", () => {
    expect(nextProjectColor([])).toBe("violet");
    expect(nextProjectColor([subject("violet"), subject("pink")])).toBe("teal");
    const all = (
      [
        "violet",
        "teal",
        "pink",
        "gray",
        "blue",
        "indigo",
        "brown",
        "slate",
      ] as const
    ).map(subject);
    expect(nextProjectColor(all)).toBe("violet");
    expect(nextProjectColor([...all, subject("teal")])).toBe("pink");
  });

  it("treats only loaded, empty data as a first launch", () => {
    expect(isFirstLaunch([], false)).toBe(true);
    expect(isFirstLaunch(undefined, false)).toBe(false);
    expect(isFirstLaunch([], undefined)).toBe(false);
    expect(isFirstLaunch([], true)).toBe(false);
    expect(isFirstLaunch([subject("violet")], false)).toBe(false);
  });
});
