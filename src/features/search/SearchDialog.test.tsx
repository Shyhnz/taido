import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const task = (
  title: string,
  subjectId: string | null = null,
  sectionId: string | null = null,
) =>
  commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId,
    dueDate: null,
    dueTime: null,
  });

async function seed() {
  const globex = await commands.createSubject({
    name: "Globex",
    color: "teal",
    rootPath: null,
    parentId: null,
  });
  const section = await commands.createSection({
    subjectId: globex.id,
    name: "Export",
    subpath: null,
  });
  const csv = await task("Exporter le CSV", globex.id, section.id);
  const pdf = await task("Exporter le PDF", globex.id);
  await commands.setTaskCompleted({ id: pdf.id, completed: true });
  const loose = await task("Exporter les factures");
  return { globex, section, csv, pdf, loose };
}

async function openSearch() {
  const user = userEvent.setup();
  render(<App />);
  // The « Recherche » row of the sidebar opens ⌘K.
  await user.click(await screen.findByRole("button", { name: "Recherche" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Rechercher",
  });
  const field = within(dialog).getByRole("combobox", {
    name: "Rechercher une tâche ou une note",
  });
  return { user, dialog, field };
}

describe("⌘K « Aller à une tâche »", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens from the magnifier with the field focused and a hint", async () => {
    const { dialog, field } = await openSearch();
    expect(field).toHaveFocus();
    expect(dialog).toHaveTextContent(
      "Tape le nom d'une tâche, d'un projet ou d'une note.",
    );
    expect(within(dialog).queryByRole("option")).toBeNull();
  });

  it("lists the hits with their ring and place, completed ones dimmed", async () => {
    await seed();
    const spy = vi.spyOn(commands, "searchTasks");
    const { user, dialog, field } = await openSearch();
    await user.type(field, "export");
    const list = await within(dialog).findByRole("listbox", {
      name: "Résultats",
    });
    const options = await within(list).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Exporter le CSV"),
      expect.stringContaining("Exporter les factures"),
      expect.stringContaining("Exporter le PDF"),
    ]);
    // Debounced: one call for the whole word, not one per letter.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("export");
    expect(options[0]).toHaveTextContent("Globex › Export");
    // The checkbox shows completion, Claude's dot only when it runs.
    const ring0 = options[0].querySelector("svg[data-priority]");
    expect(ring0).not.toHaveAttribute("data-completed");
    expect(options[0].querySelector("[data-state-dot]")).toBeNull();
    expect(options[1]).toHaveTextContent("Sans projet");
    expect(options[2]).toHaveAttribute("data-completed", "true");
    expect(options[2]).toHaveTextContent("terminée");
    expect(options[2].querySelector("svg[data-priority]")).toHaveAttribute(
      "data-completed",
      "true",
    );
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("says when nothing matches", async () => {
    await seed();
    const { user, dialog, field } = await openSearch();
    await user.type(field, "zzz");
    expect(
      await within(dialog).findByText(
        "Aucune tâche ni note ne correspond à « zzz ».",
      ),
    ).toBeInTheDocument();
  });

  it("chooses with ↑ ↓ and opens the task in its project with Entrée", async () => {
    const { globex, csv, pdf } = await seed();
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", {
      name: "Rechercher",
    });
    const field = within(dialog).getByRole("combobox");
    await user.type(field, "exporter");
    const options = await within(dialog).findAllByRole("option");
    expect(field).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(field).toHaveAttribute("aria-activedescendant", options[2].id);
    await user.keyboard("{ArrowDown}");
    expect(field).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{ArrowUp}");
    expect(options[2]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    const ui = useUi.getState();
    expect(ui.view).toEqual({ kind: "subject", subjectId: globex.id });
    expect(ui.openTaskId).toBe(pdf.id);
    expect(ui.selectedTaskId).toBe(pdf.id);
    const panel = await screen.findByRole("region", {
      name: "Panneau de la tâche",
    });
    expect(
      await within(panel).findByRole("textbox", { name: "Titre de la tâche" }),
    ).toHaveValue("Exporter le PDF");
    expect(csv.id).not.toBe(pdf.id);
  });

  it("Entrée typed before the new hits arrive opens a hit of the new text", async () => {
    const { pdf } = await seed();
    const { user, dialog, field } = await openSearch();
    await user.type(field, "exporter");
    expect(await within(dialog).findAllByRole("option")).toHaveLength(3);
    // The previous hits are still shown when Entrée comes, within the debounce.
    await user.type(field, " pdf{Enter}");
    await waitFor(() => expect(useUi.getState().openTaskId).toBe(pdf.id));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a task without project in « Sans projet », by a click", async () => {
    const { loose } = await seed();
    const { user, dialog, field } = await openSearch();
    await user.type(field, "factures");
    await user.click(
      await within(dialog).findByRole("option", {
        name: /Exporter les factures/,
      }),
    );
    expect(useUi.getState().view).toEqual({ kind: "inbox", subjectId: null });
    expect(useUi.getState().openTaskId).toBe(loose.id);
  });

  it("closes with Échap", async () => {
    const { user } = await openSearch();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers to retry when the search fails", async () => {
    await seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = commands.searchTasks;
    const spy = vi
      .spyOn(commands, "searchTasks")
      .mockRejectedValueOnce({ kind: "internal", message: "db locked" })
      .mockImplementation(real);
    const { user, dialog, field } = await openSearch();
    await user.type(field, "csv");
    expect(
      await within(dialog).findByText("La recherche a échoué."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    expect(
      await within(dialog).findByRole("option", { name: /Exporter le CSV/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
  it("lists notebook pages after the tasks, and opens the project's notes", async () => {
    const { globex } = await seed();
    vi.spyOn(commands, "searchNotes").mockResolvedValue([
      {
        id: "p1",
        title: "Export des factures",
        subject: { id: globex.id, name: "Globex", color: "teal" },
        kind: "page",
      },
    ]);
    const { user, dialog, field } = await openSearch();
    await user.type(field, "export");
    const page = await within(dialog).findByRole("option", {
      name: /Export des factures/,
    });
    expect(page).toHaveTextContent("Note · Globex");
    const options = within(dialog).getAllByRole("option");
    expect(options[options.length - 1]).toBe(page);
    await user.click(page);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: globex.id,
    });
    expect(useUi.getState().projectTab).toBe("notes");
    // The page itself is the one the notebook shows.
    expect(useUi.getState().lastNotePage[globex.id]).toBe("p1");
  });

  it("still lists the tasks when the notebook search fails", async () => {
    await seed();
    vi.spyOn(commands, "searchNotes").mockRejectedValue(new Error("nope"));
    const { user, dialog, field } = await openSearch();
    await user.type(field, "csv");
    expect(
      await within(dialog).findByRole("option", { name: /Exporter le CSV/ }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});
