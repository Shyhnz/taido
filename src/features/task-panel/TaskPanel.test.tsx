import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import {
  createQueryClient,
  INVALIDATION_THROTTLE_MS,
  queryKeys,
} from "../../lib/queries";
import { settingsPatch } from "../../lib/settingsPatch";
import { resetUi, useUi } from "../../stores/ui";
import { SAVE_DELAY_MS } from "./debouncedSave";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function createTask(title: string, subjectId: string | null = null) {
  return backend().commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await screen.findByRole("region", {
    name: "Panneau de la tâche",
  });
  // Wait for the task detail.
  await within(panel).findByRole("textbox", { name: "Titre de la tâche" });
  return panel;
}

const stored = (id: string) => backend().state.tasks.find((t) => t.id === id);

describe("task panel", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
    window.localStorage.clear();
  });

  it("shows one column: title, chips, note, subtasks, collapsed history", async () => {
    const task = await createTask("Préparer le devis");
    render(<App />);
    const panel = await openPanel(task.id);

    const title = await within(panel).findByRole("textbox", {
      name: "Titre de la tâche",
    });
    // The title gets the focus on open.
    await waitFor(() => expect(title).toHaveFocus());
    expect(
      within(panel).getByRole("button", {
        name: "Projet : Sans projet. Changer",
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Échéance" }),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Note" })).toBeVisible();
    // Layout C: empty sections wait on the « Ajouter : … » line.
    expect(
      within(panel).getByRole("button", { name: "Sous-tâche" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: /^Historique/ }),
    ).toHaveAttribute("aria-expanded", "false");
    // No terminal yet: no « Session » block; technical details folded.
    expect(within(panel).queryByText("Session")).toBeNull();
    expect(within(panel).queryByText("Branche git")).toBeNull();
    expect(
      within(panel).getByRole("button", { name: /^Dossier et branche/ }),
    ).toHaveAttribute("aria-expanded", "false");
    // No native date or time input anywhere.
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(document.querySelector('input[type="time"]')).toBeNull();
  });

  it("saves the title after a pause, not per keystroke (bug #2)", async () => {
    const task = await createTask("Brouillon");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    const title = await within(panel).findByRole("textbox", {
      name: "Titre de la tâche",
    });
    await user.clear(title);
    await user.type(title, "Devis final");
    // Not sent yet.
    expect(stored(task.id)?.title).toBe("Brouillon");
    await waitFor(() => expect(stored(task.id)?.title).toBe("Devis final"), {
      timeout: SAVE_DELAY_MS + 1000,
    });
    // The field kept what was typed.
    expect(title).toHaveValue("Devis final");
  });

  it("flushes the note when the panel closes", async () => {
    const task = await createTask("Lire");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    await user.type(
      within(panel).getByRole("textbox", { name: "Note" }),
      "Page 42",
    );
    expect(stored(task.id)?.description).toBe("");
    await user.click(
      within(panel).getByRole("button", { name: "Fermer le panneau" }),
    );
    await waitFor(() => expect(stored(task.id)?.description).toBe("Page 42"));
  });

  it("flushes the title when another task opens", async () => {
    const a = await createTask("Tâche A");
    const b = await createTask("Tâche B");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(a.id);
    const title = within(panel).getByRole("textbox", {
      name: "Titre de la tâche",
    });
    await user.type(title, " modifiée");
    act(() => useUi.getState().openTask(b.id));
    await waitFor(() => expect(stored(a.id)?.title).toBe("Tâche A modifiée"));
    expect(
      await screen.findByDisplayValue("Tâche B", undefined, {}),
    ).toBeInTheDocument();
  });

  it("flushes pending edits on window unload", async () => {
    const task = await createTask("Avant");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    await user.type(
      within(panel).getByRole("textbox", { name: "Note" }),
      "Écrit juste avant ⌘Q",
    );
    window.dispatchEvent(new Event("beforeunload"));
    await waitFor(() =>
      expect(stored(task.id)?.description).toBe("Écrit juste avant ⌘Q"),
    );
  });

  it("does not save an emptied title and restores it on blur", async () => {
    const task = await createTask("Garder ce titre");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    const title = within(panel).getByRole("textbox", {
      name: "Titre de la tâche",
    });
    await user.clear(title);
    await user.click(within(panel).getByRole("textbox", { name: "Note" }));
    expect(title).toHaveValue("Garder ce titre");
    expect(stored(task.id)?.title).toBe("Garder ce titre");
  });

  it("sets the due date with the French picker, then a time, then removes it", async () => {
    const task = await createTask("Appeler Paul");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    await user.click(within(panel).getByRole("button", { name: "Échéance" }));
    let picker = await screen.findByRole("dialog", {
      name: "Choisir l'échéance",
    });
    await user.click(within(picker).getByRole("button", { name: /^Demain/ }));
    await waitFor(() => expect(stored(task.id)?.dueDate).not.toBeNull());
    expect(
      screen.queryByRole("dialog", { name: "Choisir l'échéance" }),
    ).toBeNull();
    const chip = await within(panel).findByRole("button", {
      name: "Échéance : Demain. Changer",
    });
    // Focus is back on the chip.
    expect(chip).toHaveFocus();

    await user.click(chip);
    picker = await screen.findByRole("dialog", { name: "Choisir l'échéance" });
    await user.type(
      within(picker).getByRole("textbox", { name: "Heure" }),
      "17h{Enter}",
    );
    await waitFor(() => expect(stored(task.id)?.dueTime).toBe("17:00"));
    expect(
      await within(panel).findByRole("button", {
        name: "Échéance : Demain 17:00. Changer",
      }),
    ).toBeInTheDocument();

    await user.click(
      within(panel).getByRole("button", { name: /^Échéance : Demain 17:00/ }),
    );
    picker = await screen.findByRole("dialog", { name: "Choisir l'échéance" });
    await user.click(
      within(picker).getByRole("button", { name: "Retirer l'échéance" }),
    );
    await waitFor(() => expect(stored(task.id)?.dueDate).toBeNull());
    expect(stored(task.id)?.dueTime).toBeNull();
  });

  it("moves the task with the location chip", async () => {
    const subject = await backend().commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    await backend().commands.createSection({
      subjectId: subject.id,
      name: "Summit Events",
      subpath: null,
    });
    const task = await createTask("Préparer le devis");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    await user.click(
      within(panel).getByRole("button", {
        name: "Projet : Sans projet. Changer",
      }),
    );
    const menu = await screen.findByRole("menu", { name: "Ranger dans…" });
    await user.click(
      within(menu).getByRole("menuitemcheckbox", {
        name: "Globex › Summit Events",
      }),
    );
    expect(
      await within(panel).findByRole("button", {
        name: "Projet : Globex › Summit Events. Changer",
      }),
    ).toBeInTheDocument();
    expect(stored(task.id)?.subjectId).toBe(subject.id);

    // Back to « Sans projet ».
    await user.click(
      within(panel).getByRole("button", { name: /^Projet : Globex/ }),
    );
    await user.click(
      within(
        await screen.findByRole("menu", { name: "Ranger dans…" }),
      ).getByRole("menuitemcheckbox", { name: "Sans projet" }),
    );
    await waitFor(() => expect(stored(task.id)?.subjectId).toBeNull());
  });

  it("names the default agent on the launch button, and follows a change at once", async () => {
    const task = await createTask("Sans terminal");
    render(<App />);
    const panel = await openPanel(task.id);
    const bar = within(panel).getByRole("toolbar", {
      name: "Lancer un terminal ou ouvrir le dossier",
    });
    expect(
      within(bar).getByRole("button", { name: /Lancer Claude Code/ }),
    ).toBeInTheDocument();
    await act(() =>
      commands.updateSettings(settingsPatch({ defaultAgent: "codex" })),
    );
    expect(
      await within(bar).findByRole("button", { name: /Lancer Codex/ }),
    ).toBeInTheDocument();
  });

  it("shows the terminal actions one click away, rarer ones in ⋯ (option B)", async () => {
    const task = await createTask("Sans terminal");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    const bar = within(panel).getByRole("toolbar", {
      name: "Lancer un terminal ou ouvrir le dossier",
    });
    for (const name of [
      /Lancer Claude Code/,
      /Shell/,
      "Ouvrir dans le Finder",
    ]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    // Leaving the app for an editor stays in ⋯.
    expect(within(bar).queryByRole("button", { name: /VS Code/ })).toBeNull();
    await user.click(
      within(panel).getByRole("button", {
        name: "Plus d'actions sur la tâche",
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: /Ouvrir dans/ }),
    ).toBeInTheDocument();
  });

  it("« Ouvrir dans » lists the installed editors, the last used first", async () => {
    backend().installedEditorsHere = ["vscode", "zed"];
    const subject = await commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const task = await createTask("Exporter", subject.id);
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    const open = vi.spyOn(commands, "openPath");
    const openIn = async () => {
      await user.click(
        within(panel).getByRole("button", {
          name: "Plus d'actions sur la tâche",
        }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: /Ouvrir dans/ }),
      );
      const menu = await screen.findByRole("menu", { name: "Ouvrir dans" });
      return within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
    };
    // Cursor, Windsurf and Sublime Text are not installed: not offered.
    expect(await openIn()).toEqual(["VS Code", "Zed", "Finder", "Terminal"]);
    await user.click(screen.getByRole("menuitem", { name: "Zed" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        path: "/tmp/globex",
        with: "editor",
        editor: "zed",
      }),
    );
    await waitFor(async () =>
      expect((await commands.getSettings()).editor).toBe("zed"),
    );
    // The settings are read again after the throttled `data-changed`.
    await act(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, INVALIDATION_THROTTLE_MS * 3),
        ),
    );
    expect(await openIn()).toEqual(["Zed", "VS Code", "Finder", "Terminal"]);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await waitFor(() =>
      expect(open).toHaveBeenLastCalledWith({
        path: "/tmp/globex",
        with: "terminal",
        editor: null,
      }),
    );
  });

  it("« Ouvrir dans » keeps the Finder and Terminal without any editor", async () => {
    backend().installedEditorsHere = [];
    const task = await createTask("Sans éditeur");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    await user.click(
      within(panel).getByRole("button", {
        name: "Plus d'actions sur la tâche",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Ouvrir dans/ }),
    );
    const menu = await screen.findByRole("menu", { name: "Ouvrir dans" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Finder", "Terminal"]);
  });

  it("moves the Finder to the tab bar once a terminal is open", async () => {
    const task = await createTask("Avec terminal");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    // No folder yet: the mock's folder picker answers, then the shell opens.
    await user.click(within(panel).getByRole("button", { name: /Shell/ }));
    await within(panel).findByRole("tab", { name: /Shell/ });
    expect(
      within(panel).queryByRole("toolbar", {
        name: "Lancer un terminal ou ouvrir le dossier",
      }),
    ).toBeNull();
    expect(
      within(panel).getByRole("button", { name: "Ouvrir dans le Finder" }),
    ).toBeInTheDocument();
  });

  it("deletes from ⋯ without confirmation and undoes from the toast", async () => {
    const task = await createTask("À supprimer");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    await user.click(
      within(panel).getByRole("button", {
        name: "Plus d'actions sur la tâche",
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Déplacer vers…" }),
    ).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Supprimer" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Panneau de la tâche" }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored(task.id)?.deletedAt).not.toBeNull();
    const toast = (
      await screen.findByText("Tâche supprimée")
    ).closest<HTMLElement>('[role="status"]');
    if (!toast) throw new Error("no toast");
    await user.click(within(toast).getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(stored(task.id)?.deletedAt).toBeNull());
    expect(
      await screen.findByRole("region", { name: "Panneau de la tâche" }),
    ).toBeInTheDocument();
  });

  it("toggles subtasks with mini-circles", async () => {
    const task = await createTask("Avec sous-tâches");
    await backend().commands.addSubtask({ taskId: task.id, text: "Volumes" });
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);
    const circle = await within(panel).findByRole("checkbox", {
      name: "Volumes",
    });
    expect(circle.tagName).toBe("BUTTON");
    expect(circle).toHaveAttribute("aria-checked", "false");
    await user.click(circle);
    await waitFor(() =>
      expect(
        within(panel).getByRole("checkbox", { name: "Volumes" }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    // Layout C: the counter sits at the end of the « Sous-tâches » row only.
    expect(within(panel).getAllByText("1/1")).toHaveLength(1);
    expect(
      within(panel).getByTitle("1 sous-tâche faite sur 1"),
    ).toBeInTheDocument();
  });

  it("returns the focus to the task row when Escape closes the panel", async () => {
    const task = await createTask("Revenir ici");
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /Sans projet/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Revenir ici" }),
    );
    const panel = await screen.findByRole("region", {
      name: "Panneau de la tâche",
    });
    const title = within(panel).getByRole("textbox", {
      name: "Titre de la tâche",
    });
    await waitFor(() => expect(title).toHaveFocus());
    // First Escape leaves the field, the second closes the panel.
    await user.keyboard("{Escape}");
    expect(title).not.toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Panneau de la tâche" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revenir ici" })).toHaveFocus(),
    );
    expect(task.id).toBeTruthy();
  });

  it("refreshes the git branch every 30 s while the panel is open (bug #3)", async () => {
    const task = await createTask("Sans polling");
    const client = createQueryClient();
    render(<App client={client} />);
    await openPanel(task.id);
    const query = client
      .getQueryCache()
      .find({ queryKey: queryKeys.task(task.id) });
    expect(query).toBeDefined();
    const intervals = query?.observers.map((o) => o.options.refetchInterval);
    expect(intervals?.length).toBeGreaterThan(0);
    for (const interval of intervals ?? []) expect(interval).toBe(30_000);
  });
});
