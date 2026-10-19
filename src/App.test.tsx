import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { useToasts } from "./components/Toast";
import { fr } from "./i18n/fr";
import { mockBackend } from "./lib/ipc";
import { resetUi, SIDEBAR_KEY } from "./stores/ui";

describe("App with the mock backend", () => {
  beforeEach(() => {
    mockBackend?.reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });

  it("folds the sidebar and shows it again (remembered)", async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = () => screen.queryByRole("navigation", { name: "Navigation" });
    expect(nav()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: fr.sidebar.collapse }));
    expect(nav()).toBeNull();
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("false");
    await user.click(screen.getByRole("button", { name: fr.sidebar.expand }));
    expect(nav()).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("true");
  });

  it("creates a project, adds a task, checks it and undoes", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const user = userEvent.setup();
    render(<App />);

    // First launch: « Commence par un projet ».
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Commence par un projet",
      }),
    ).toBeInTheDocument();

    // New project in place in the sidebar: name + Enter, no dialog, no folder (D5).
    await user.click(screen.getByRole("button", { name: "Créer un projet" }));
    const input = screen.getByRole("textbox", {
      name: "Nom du nouveau projet",
    });
    expect(input).toHaveFocus();
    await user.type(input, "Acme Studio{Enter}");

    // The project view opens.
    const main = screen.getByRole("main");
    expect(
      await within(main).findByRole("heading", {
        level: 1,
        name: /Acme Studio/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockBackend.state.subjects[0]).toMatchObject({
      name: "Acme Studio",
      color: "violet",
      rootPath: null,
    });
    expect(
      screen.getByRole("navigation", { name: "Navigation" }),
    ).toBeInTheDocument();

    // The new project opens with the cursor in its add-task line; Enter keeps it open.
    await waitFor(() =>
      expect(within(main).getByLabelText("Nom de la tâche")).toHaveFocus(),
    );
    await user.type(
      within(main).getByLabelText("Nom de la tâche"),
      "Relancer la DSI{Enter}",
    );
    expect(within(main).getByLabelText("Nom de la tâche")).toHaveValue("");
    expect(
      await within(main).findByRole("button", { name: "Relancer la DSI" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(main).queryByLabelText("Nom de la tâche")).toBeNull();

    // Sidebar counter of the project.
    const sidebarSubject = screen.getByRole("button", { name: /^Acme Studio/ });
    await waitFor(() => expect(sidebarSubject).toHaveTextContent("1"));

    // Check it: the row goes to "Terminées" and a toast offers to undo.
    await user.click(
      within(main).getByRole("button", {
        name: "Terminer",
      }),
    );
    // The animation holds the row 700 ms and folds it in 200 ms before checking it.
    const toastText = await screen.findByText(
      "Tâche terminée",
      {},
      { timeout: 3000 },
    );
    const toast = toastText.closest<HTMLElement>('[role="status"]');
    if (!toast) throw new Error("no toast");
    const completedToggle = await within(main).findByRole("button", {
      name: /Terminées/,
    });
    expect(completedToggle).toHaveTextContent("1");
    expect(mockBackend.state.tasks[0].completedAt).not.toBeNull();

    // Undo.
    await user.click(within(toast).getByRole("button", { name: "Annuler" }));
    expect(
      await within(main).findByRole("button", {
        name: "Terminer",
      }),
    ).toBeInTheDocument();
    expect(mockBackend.state.tasks[0].completedAt).toBeNull();
    const journal = await mockBackend.commands.listJournal(
      mockBackend.state.tasks[0].id,
    );
    expect(journal.map((j) => j.kind)).toEqual([
      "reopened",
      "completed",
      "created",
    ]);
  });

  it("opens the task panel and edits subtasks and shows the history", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const user = userEvent.setup();
    const task = await mockBackend.commands.createTask({
      title: "Lire l'article",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    render(<App />);
    // « Sans projet » shows up in the sidebar because one task has no project.
    await user.click(
      await screen.findByRole("button", { name: /Sans projet/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Lire l'article" }),
    );

    const panel = await screen.findByRole("region", {
      name: "Panneau de la tâche",
    });
    // Layout C: an empty « Sous-tâches » is offered on the « Ajouter : … » line.
    await user.click(within(panel).getByRole("button", { name: "Sous-tâche" }));
    await user.type(
      within(panel).getByRole("textbox", { name: "Ajouter une sous-tâche" }),
      "Prendre des notes{Enter}",
    );
    expect(
      await within(panel).findByRole("checkbox", { name: "Prendre des notes" }),
    ).toBeInTheDocument();

    // « Historique » is collapsed by default.
    expect(within(panel).queryByText("Tâche créée")).toBeNull();
    await user.click(
      within(panel).getByRole("button", { name: /^Historique/ }),
    );
    expect(await within(panel).findByText("Tâche créée")).toBeInTheDocument();
    // Read-only: no field to add a line by hand.
    expect(
      within(panel).queryByRole("textbox", { name: /historique/i }),
    ).toBeNull();

    // Escape (outside a field) closes the panel.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Panneau de la tâche" }),
      ).toBeNull(),
    );
    expect((await mockBackend.commands.getTask(task.id)).subtasks).toHaveLength(
      1,
    );
  });
});
