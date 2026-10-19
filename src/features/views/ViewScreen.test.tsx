/**
 * Views: project, Today and « Sans projet » lists, the
 * in-place editor, the list keyboard and the loading / error states.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { CreateTaskInput } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { todayString, toLocalDateString } from "../../lib/dates";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { useCompletion } from "../task-row/actions";
import { requestAddSection, resetList } from "./listStore";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const task = (input: Partial<CreateTaskInput> & { title: string }) =>
  backend().commands.createTask({
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
    ...input,
  });

const main = () => screen.getByRole("main");

const realMatchMedia = window.matchMedia;

/** « Réduire les animations »: completions are committed at once. */
function reduceMotion() {
  window.matchMedia = (query: string) =>
    ({
      ...realMatchMedia(query),
      matches: query.includes("prefers-reduced-motion"),
    }) as MediaQueryList;
}

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  resetList();
  useCompletion.setState({ phases: {} });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe("Project view", () => {
  it("lists loose tasks first without header, then discreet sections", async () => {
    const b = backend();
    const globex = await b.commands.createSubject({
      name: "Globex",
      color: "pink",
      rootPath: null,
      parentId: null,
    });
    const peak = await b.commands.createSection({
      subjectId: globex.id,
      name: "Summit Events",
      subpath: null,
    });
    await task({ title: "Préparer le devis", subjectId: globex.id });
    await task({
      title: "Export CSV",
      subjectId: globex.id,
      sectionId: peak.id,
    });
    useUi.getState().setView({ kind: "subject", subjectId: globex.id });
    render(<App />);

    const m = main();
    expect(
      await within(m).findByRole("heading", { level: 1, name: "Globex" }),
    ).toBeInTheDocument();
    expect(within(m).getByText("2 tâches")).toBeInTheDocument();
    // Only the section has a header; « Sans section » never shows.
    const headings = within(m)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Summit Events"]);
    expect(within(m).queryByText("Sans section")).toBeNull();
    // One « Ajouter… » line per group, no path, no mono.
    expect(within(m).getAllByRole("button", { name: "Ajouter…" })).toHaveLength(
      2,
    );
    expect(m.querySelector(".font-mono")).toBeNull();
    // The rows are in display order: loose task first.
    const titles = Array.from(m.querySelectorAll("[data-row-focus]")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Préparer le devis", "Export CSV"]);
  });

  it("hides the subtitle of an empty project", async () => {
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    useUi.getState().setView({ kind: "subject", subjectId: globex.id });
    render(<App />);
    expect(await screen.findByText("Ce projet est vide")).toBeInTheDocument();
    expect(within(main()).queryByText(/^(0 tâche|Aucune tâche)$/)).toBeNull();
  });

  it("adds a section from the project ⋯ menu, without sub-folder", async () => {
    const user = userEvent.setup();
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    useUi.getState().setView({ kind: "subject", subjectId: globex.id });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", {
        name: "Actions du projet Globex",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Ajouter une section" }),
    );
    const field = await within(main()).findByLabelText("Nom de la section");
    expect(within(main()).queryByText(/Sous-dossier/)).toBeNull();
    await user.type(field, "Summit Events{Enter}");
    expect(
      await within(main()).findByRole("heading", {
        level: 2,
        name: "Summit Events",
      }),
    ).toBeInTheDocument();
    expect(within(main()).queryByLabelText("Nom de la section")).toBeNull();
  });

  it("opens the section field when another area requests it", async () => {
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    render(<App />);
    act(() => requestAddSection(globex.id));
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: globex.id,
    });
    expect(
      await within(main()).findByLabelText("Nom de la section"),
    ).toBeInTheDocument();
  });

  it("goes back to Today with a toast when the project is gone", async () => {
    // Another project exists, so this is not the first-launch screen.
    await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    useUi.getState().setView({ kind: "subject", subjectId: "nope" });
    render(<App />);
    expect(
      await screen.findByText("Ce projet n'existe plus"),
    ).toBeInTheDocument();
    await waitFor(() => expect(useUi.getState().view.kind).toBe("today"));
  });
});

describe("In-place editor", () => {
  it("adds with Enter, stays open, and never adds from the Annuler button (bug #8)", async () => {
    const user = userEvent.setup();
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    useUi.getState().setView({ kind: "subject", subjectId: globex.id });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Ajouter…" }),
    );
    const title = within(main()).getByLabelText("Nom de la tâche");
    // No overlay: the editor lives in the list.
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.type(title, "Relancer la DSI");
    // Tab goes to the note.
    await user.tab();
    expect(within(main()).getByLabelText("Note")).toHaveFocus();

    // Enter on « Annuler » closes without adding.
    const cancel = within(main()).getByRole("button", { name: "Annuler" });
    cancel.focus();
    await user.keyboard("{Enter}");
    expect(backend().state.tasks).toHaveLength(0);
    expect(within(main()).queryByLabelText("Nom de la tâche")).toBeNull();

    await user.click(within(main()).getByRole("button", { name: "Ajouter…" }));
    await user.type(
      within(main()).getByLabelText("Nom de la tâche"),
      "Relancer la DSI{Enter}",
    );
    expect(within(main()).getByLabelText("Nom de la tâche")).toHaveValue("");
    expect(backend().state.tasks[0]).toMatchObject({
      title: "Relancer la DSI",
      subjectId: globex.id,
      sectionId: null,
    });
  });

  it("adds from Today to « Sans projet », due today", async () => {
    const user = userEvent.setup();
    await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Ajouter…" }),
    );
    expect(
      within(main()).getByRole("button", {
        name: "Destination : Sans projet. Changer",
      }),
    ).toBeInTheDocument();
    await user.type(
      within(main()).getByLabelText("Nom de la tâche"),
      "Payer la facture{Enter}",
    );
    expect(backend().state.tasks[0]).toMatchObject({
      subjectId: null,
      dueDate: todayString(),
    });
    expect(
      await within(main()).findByRole("button", { name: "Payer la facture" }),
    ).toBeInTheDocument();
  });

  it("changes the destination with the chip and says where the task went", async () => {
    const user = userEvent.setup();
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Ajouter…" }),
    );
    await user.click(
      within(main()).getByRole("button", {
        name: "Destination : Sans projet. Changer",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Globex" }));
    await user.click(
      within(main()).getByRole("button", {
        name: /^Échéance : Aujourd'hui/,
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Retirer l'échéance" }),
    );
    await user.type(
      within(main()).getByLabelText("Nom de la tâche"),
      "Devis{Enter}",
    );
    expect(backend().state.tasks[0]).toMatchObject({
      subjectId: globex.id,
      dueDate: null,
    });
    const toast = await screen.findByText("Ajoutée dans Globex");
    await user.click(
      within(
        toast.closest<HTMLElement>('[role="status"]') ?? document.body,
      ).getByRole("button", { name: "Voir" }),
    );
    expect(useUi.getState().view).toEqual({
      kind: "subject",
      subjectId: globex.id,
    });
  });

  it("says where the task went when its due date takes it out of Today", async () => {
    const user = userEvent.setup();
    await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Ajouter…" }),
    );
    await user.click(
      within(main()).getByRole("button", {
        name: /^Échéance : Aujourd'hui/,
      }),
    );
    await user.click(await screen.findByRole("button", { name: /^Demain/ }));
    await user.type(
      within(main()).getByLabelText("Nom de la tâche"),
      "Relancer{Enter}",
    );
    expect(backend().state.tasks[0]).toMatchObject({ subjectId: null });
    const toast = await screen.findByText("Ajoutée dans Sans projet");
    await user.click(
      within(
        toast.closest<HTMLElement>('[role="status"]') ?? document.body,
      ).getByRole("button", { name: "Voir" }),
    );
    expect(useUi.getState().view).toEqual({ kind: "inbox", subjectId: null });
  });
});

describe("Today view", () => {
  it("shows « En retard » with « Reporter à aujourd'hui »", async () => {
    const user = userEvent.setup();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await task({
      title: "Relance planning",
      dueDate: toLocalDateString(yesterday),
    });
    await task({ title: "Point hebdo", dueDate: todayString() });
    render(<App />);
    const late = await within(main()).findByRole("region", {
      name: "En retard",
    });
    expect(within(late).getByText("Relance planning")).toBeInTheDocument();
    expect(
      within(late).getByText("En retard · Hier").closest("[data-overdue]")
        ?.className,
    ).toContain("text-due-overdue");
    // Today's own due date says nothing new in Today.
    for (const list of main().querySelectorAll<HTMLElement>(
      "[data-task-list]",
    )) {
      expect(within(list).queryByText("Aujourd'hui")).toBeNull();
    }

    await user.click(
      within(late).getByRole("button", { name: "Reporter à aujourd'hui" }),
    );
    expect(
      await screen.findByText("Tâche reportée à aujourd'hui"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(main()).queryByRole("region", { name: "En retard" }),
      ).toBeNull(),
    );
    expect(
      backend().state.tasks.every((t) => t.dueDate === todayString()),
    ).toBe(true);
  });

  it("shows the first-launch screen when there is nothing at all", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(
      await screen.findByText("Commence par un projet"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Créer un projet" }));
    // The sidebar « Nouveau projet » line becomes a field.
    expect(useUi.getState().newProjectOpen).toBe(true);
    expect(
      await screen.findByRole("textbox", { name: "Nom du nouveau projet" }),
    ).toHaveFocus();
  });
});

describe("« Sans projet » view", () => {
  it("files a task into a project with « Ranger dans… »", async () => {
    const user = userEvent.setup();
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const t = await task({ title: "Lire l'article" });
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    render(<App />);
    expect(await within(main()).findByText("1 tâche")).toBeInTheDocument();
    await user.click(
      await within(main()).findByRole("button", {
        name: "Ranger « Lire l'article » dans un projet",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Globex" }));
    await waitFor(async () =>
      expect((await backend().commands.getTask(t.id)).subject?.id).toBe(
        globex.id,
      ),
    );
    expect(await screen.findByText("Déplacée dans Globex")).toBeInTheDocument();
  });
});

describe("Rows", () => {
  it("deletes without confirmation and restores with Annuler", async () => {
    const user = userEvent.setup();
    await task({ title: "Lire l'article" });
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", {
        name: "Actions de la tâche Lire l'article",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Supprimer" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const toast = (
      await screen.findByText("Tâche supprimée")
    ).closest<HTMLElement>('[role="status"]');
    if (!toast) throw new Error("no toast");
    await waitFor(() =>
      expect(
        within(main()).queryByRole("button", { name: "Lire l'article" }),
      ).toBeNull(),
    );
    await user.click(within(toast).getByRole("button", { name: "Annuler" }));
    expect(
      await within(main()).findByRole("button", { name: "Lire l'article" }),
    ).toBeInTheDocument();
  });

  it("animates a completion, and a second click cancels it", async () => {
    const user = userEvent.setup();
    const t = await task({ title: "A" });
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    render(<App />);
    const ring = await within(main()).findByRole("button", {
      name: "Terminer",
    });
    await user.click(ring);
    const row = main().querySelector(`[data-task-id="${t.id}"]`);
    expect(row).toHaveAttribute("data-completing", "checking");
    // Second click during the hold: nothing is checked.
    await user.click(within(main()).getByRole("button", { name: "Rouvrir" }));
    expect(row).not.toHaveAttribute("data-completing");
    await new Promise((r) => setTimeout(r, 1000));
    expect(backend().state.tasks[0].completedAt).toBeNull();
  });
});

describe("List keyboard", () => {
  async function threeTasks() {
    const globex = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    for (const title of ["A", "B", "C"]) {
      await task({ title, subjectId: globex.id });
    }
    useUi.getState().setView({ kind: "subject", subjectId: globex.id });
    render(<App />);
    await within(main()).findByRole("button", { name: "C" });
    return globex;
  }

  const rowButton = (name: string) =>
    within(main()).getByRole("button", { name });

  it("has one tab stop and moves with ↑/↓ and j/k", async () => {
    const user = userEvent.setup();
    await threeTasks();
    const tabbable = Array.from(
      main().querySelectorAll("[data-row-focus]"),
    ).filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable.map((el) => el.textContent)).toEqual(["A"]);

    rowButton("A").focus();
    await user.keyboard("{ArrowDown}");
    expect(rowButton("B")).toHaveFocus();
    await user.keyboard("j");
    expect(rowButton("C")).toHaveFocus();
    await user.keyboard("k");
    expect(rowButton("B")).toHaveFocus();
    // The tab stop follows the focus.
    await waitFor(() =>
      expect(rowButton("B")).toHaveAttribute("tabindex", "0"),
    );
    expect(rowButton("A")).toHaveAttribute("tabindex", "-1");
  });

  it("reorders with ⌥↓ and announces it", async () => {
    const user = userEvent.setup();
    await threeTasks();
    rowButton("A").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => {
      const titles = Array.from(
        main().querySelectorAll("[data-row-focus]"),
      ).map((el) => el.textContent);
      expect(titles).toEqual(["B", "A", "C"]);
    });
    expect(
      await screen.findByText("« A » descendue d'un cran"),
    ).toBeInTheDocument();
  });

  it("checks with Space and moves the focus to the next row", async () => {
    const user = userEvent.setup();
    reduceMotion();
    await threeTasks();
    rowButton("A").focus();
    await user.keyboard(" ");
    expect(await screen.findByText("Tâche terminée")).toBeInTheDocument();
    await waitFor(() => expect(rowButton("B")).toHaveFocus());
  });

  it("checks at once with reduced motion", async () => {
    const user = userEvent.setup();
    reduceMotion();
    await threeTasks();
    await user.click(
      within(
        main().querySelector<HTMLElement>("[data-task-id]") ?? main(),
      ).getByRole("button", { name: "Terminer" }),
    );
    expect(await screen.findByText("Tâche terminée")).toBeInTheDocument();
    expect(main().querySelector("[data-completing]")).toBeNull();
  });
});

describe("Loading and errors", () => {
  it("shows an error block with Réessayer", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(commands, "getView")
      .mockRejectedValueOnce({ kind: "internal", message: "boom" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await task({ title: "Lire l'article" });
    render(<App />);
    // The toast host keeps an empty alert region mounted: look inside the list area.
    const alert = await within(main()).findByRole("alert");
    expect(alert).toHaveTextContent("Impossible d'afficher cette liste.");
    await user.click(within(alert).getByRole("button", { name: "Réessayer" }));
    expect(
      await within(main()).findByRole("heading", {
        level: 1,
        name: "Aujourd'hui",
      }),
    ).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
