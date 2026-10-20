/**
 * Attachments and relations on the mock backend: the panel's sections, the row's
 * « 📎 », « bloque N », « bloquée par : … », and the warning before Claude on a blocked task.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { openFold } from "../../test/panelFolds";
import { setTerminalList } from "../terminals/terminalList";
import { backend, taskWithFolder } from "../terminals/testSupport";

const main = () => screen.getByRole("main");

describe("attachments and relations", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    setTerminalList([]);
  });
  afterEach(() => {
    backend().reset();
    vi.restoreAllMocks();
    useToasts.setState({ toasts: [] });
  });

  it("attaches files, counts them on the row and removes the copy", async () => {
    const task = await taskWithFolder("Export PDF");
    await commands.addAttachments({
      taskId: task.id,
      paths: ["/Users/user/maquette.png", "/Users/user/maquette.png"],
    });
    let detail = await commands.getTask(task.id);
    expect(detail.attachments.map((a) => a.fileName)).toEqual([
      "maquette.png",
      "maquette (2).png",
    ]);
    expect(detail.attachments[0].path).toContain("/Pièces jointes/Globex/");
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: task.subject?.id ?? null });
    useUi.getState().openTask(task.id);
    const user = userEvent.setup();
    render(<App />);
    expect(
      await within(main()).findByTitle("2 pièces jointes"),
    ).toBeInTheDocument();
    const panel = await openFold(document.body, "Pièces jointes", "Fichier");
    await user.click(
      within(panel).getByRole("button", {
        name: "Options de « maquette (2).png »",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Retirer" }));
    // It leaves every device; the copy goes, never the original.
    expect(
      await screen.findByText(
        /retirée de tous tes appareils.*Le fichier d'origine ne bouge pas/,
      ),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Retirer" }));
    await waitFor(async () => {
      detail = await commands.getTask(task.id);
      expect(detail.attachments).toHaveLength(1);
    });

    // The × in the tile's corner removes it too, after the same confirmation.
    await user.click(
      within(panel).getByRole("button", { name: "Retirer « maquette.png »" }),
    );
    await user.click(await screen.findByRole("button", { name: "Retirer" }));
    await waitFor(async () => {
      detail = await commands.getTask(task.id);
      expect(detail.attachments).toHaveLength(0);
    });
  });

  it("« Télécharger » copies a file into Téléchargements and offers to show it in the Finder", async () => {
    const task = await taskWithFolder("Export PDF");
    await commands.addAttachments({
      taskId: task.id,
      paths: ["/Users/user/devis.pdf", "/Users/user/photo.jpg"],
    });
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: task.subject?.id ?? null });
    useUi.getState().openTask(task.id);
    const download = vi.spyOn(commands, "downloadAttachment");
    const reveal = vi.spyOn(commands, "revealPath");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openFold(document.body, "Pièces jointes", "Fichier");
    const tile = (name: string) =>
      within(panel).getByRole("button", { name: `Options de « ${name} »` });

    await user.click(tile("devis.pdf"));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Télécharger", "Afficher dans le Finder", "Retirer"]);
    expect(within(menu).queryByText("Ouvrir")).toBeNull();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Télécharger" }),
    );
    const toast = await screen.findByText("Enregistré dans Téléchargements");
    expect(download).toHaveBeenCalledWith(
      (await commands.getTask(task.id)).attachments[0].id,
    );
    await user.click(
      within(toast.parentElement as HTMLElement).getByRole("button", {
        name: "Afficher dans le Finder",
      }),
    );
    expect(reveal).toHaveBeenCalledWith("/Users/user/Downloads/devis.pdf");

    // A double-click downloads too; an image as well (never opened in place).
    await user.dblClick(tile("photo.jpg"));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(await download.mock.results[1].value).toBe(
      "/Users/user/Downloads/photo.jpg",
    );
  });

  it("« Télécharger » fetches a file from another device first, and says why it cannot", async () => {
    const task = await taskWithFolder("Export PDF");
    await commands.addAttachments({
      taskId: task.id,
      paths: ["/Users/user/plan.pdf"],
    });
    const [plan] = (await commands.getTask(task.id)).attachments;
    await commands.syncLogin({
      serverUrl: "https://taido.example.fr",
      email: "user@exemple.fr",
      password: "un mot de passe assez long",
    });
    backend().links.setRemote(plan.id, "to_download");
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: task.subject?.id ?? null });
    useUi.getState().openTask(task.id);
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const real = backend().commands.downloadAttachment;
    vi.spyOn(commands, "downloadAttachment").mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    const user = userEvent.setup();
    render(<App />);
    const panel = await openFold(document.body, "Pièces jointes", "Fichier");
    const tile = within(panel).getByRole("button", {
      name: "Options de « plan.pdf »",
    });
    expect(within(tile).getByText("À télécharger")).toBeInTheDocument();
    await user.dblClick(tile);
    // « Téléchargement… » until the copy is made; a second start meanwhile does nothing.
    expect(
      await within(tile).findByText("Téléchargement…"),
    ).toBeInTheDocument();
    await user.click(tile);
    expect(
      await screen.findByRole("menuitem", { name: "Télécharger" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    finish();
    expect(
      await screen.findByText("Enregistré dans Téléchargements"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(tile).queryByText("Téléchargement…")).toBeNull(),
    );
    // It is on this Mac now: the tile says nothing more.
    await waitFor(() =>
      expect(within(tile).queryByText("À télécharger")).toBeNull(),
    );
    expect(commands.downloadAttachment).toHaveBeenCalledTimes(1);

    // Each failure says what happened (the core's kinds, docs/SYNC.md § 0.13).
    backend().links.setRemote(plan.id, "to_download");
    const failures: [string, string][] = [
      [
        "sync_offline",
        "Ce fichier n'est pas encore sur cet appareil et le serveur est injoignable.",
      ],
      ["sync_auth", "Connexion refusée : reconnecte-toi dans les Réglages."],
      [
        "sync_server",
        "Le serveur a renvoyé une erreur pendant le téléchargement. Réessaie plus tard.",
      ],
      [
        "downloads_denied",
        "Taido n'a pas accès à Téléchargements. Autorise-le dans Réglages Système › Confidentialité et sécurité › Fichiers et dossiers › Taido › Téléchargements.",
      ],
      ["disk_full", "Plus de place sur cet appareil pour ce fichier."],
      ["file_write_failed", "Impossible d'écrire le fichier sur cet appareil."],
    ];
    for (const [kind, text] of failures) {
      vi.mocked(commands.downloadAttachment).mockRejectedValueOnce({
        kind,
        message: "download stopped",
      });
      await user.dblClick(tile);
      expect(await screen.findByText(text)).toBeInTheDocument();
    }

    // Not here and no account: nothing can bring it, « Télécharger » is off.
    backend().links.setRemote(plan.id, "to_download");
    await commands.syncUnlink();
    backend().emitDataChanged(["tasks"], [task.id]);
    await waitFor(() =>
      expect(within(tile).getByText("fichier introuvable")).toBeInTheDocument(),
    );
    const calls = vi.mocked(commands.downloadAttachment).mock.calls.length;
    await user.dblClick(tile);
    await user.click(tile);
    expect(
      await screen.findByRole("menuitem", { name: "Télécharger" }),
    ).toBeDisabled();
    expect(commands.downloadAttachment).toHaveBeenCalledTimes(calls);
  });

  it("relates tasks across projects and shows it on both sides", async () => {
    const mail = await taskWithFolder("Modèle d'e-mail");
    const relances = await commands.createTask({
      title: "Relances",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await commands.addRelation({
      taskId: relances.id,
      otherId: mail.id,
      kind: "blocked_by",
    });
    expect((await commands.getTask(mail.id)).relations.blocks[0].title).toBe(
      "Relances",
    );
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    render(<App />);
    expect(
      await within(main()).findByText("bloquée par : Modèle d'e-mail"),
    ).toBeInTheDocument();
    await commands.setTaskCompleted({ id: mail.id, completed: true });
    await waitFor(() =>
      expect(
        within(main()).queryByText("bloquée par : Modèle d'e-mail"),
      ).toBeNull(),
    );
    await expect(
      commands.addRelation({
        taskId: mail.id,
        otherId: mail.id,
        kind: "relates_to",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("shows the relation icons with their counts on the row", async () => {
    const make = (title: string) =>
      commands.createTask({
        title,
        description: null,
        subjectId: null,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
    const [guide, b1, b2, l1, x] = await Promise.all([
      make("Guide motion"),
      make("Formation"),
      make("Maquette"),
      make("Vidéo"),
      make("Export"),
    ]);
    for (const [otherId, kind] of [
      [b1.id, "blocked_by"],
      [b2.id, "blocked_by"],
      [l1.id, "relates_to"],
      [x.id, "blocks"],
    ] as const) {
      await commands.addRelation({ taskId: guide.id, otherId, kind });
    }
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    render(<App />);
    const row = (await within(main()).findByText("Guide motion")).closest(
      "[data-task-id]",
    ) as HTMLElement;
    const blocked = within(row).getByTitle(
      "bloquée par : Formation et 1 autre",
    );
    expect(blocked).toHaveTextContent("2");
    expect(within(row).getByTitle("bloque 1 tâche")).toHaveTextContent("1");
    expect(within(row).getByTitle("liée à 1 tâche")).toHaveTextContent("1");
  });

  it("links a task from the panel by searching every project", async () => {
    const a = await taskWithFolder("Export PDF");
    await commands.createTask({
      title: "Appel de recette",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: a.subject?.id ?? null });
    useUi.getState().openTask(a.id);
    const user = userEvent.setup();
    render(<App />);
    // « Ajouter : Lien » opens the section with its menu.
    const relations = await openFold(document.body, "Relations", "Lien");
    const menu = within(relations).getByRole("region", {
      name: "Lier une tâche",
    });
    await user.type(within(menu).getByRole("combobox"), "Appel");
    await user.click(
      await within(menu).findByRole("option", { name: /Appel de recette/ }),
    );
    await waitFor(async () =>
      expect((await commands.getTask(a.id)).relations.related[0]?.title).toBe(
        "Appel de recette",
      ),
    );
    expect(
      within(relations).queryByRole("region", { name: "Lier une tâche" }),
    ).toBeNull();
  });

  it("browses every task without typing, subtasks under their task", async () => {
    const a = await taskWithFolder("Rapport mensuel");
    const globex = a.subject?.id ?? null;
    const exp = await commands.createTask({
      title: "Exporter les temps",
      description: null,
      subjectId: globex,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await commands.addSubtask({ taskId: exp.id, text: "Arrondir les durées" });
    await commands.addSubtask({ taskId: exp.id, text: "Choisir les colonnes" });
    await commands.addSubtask({ taskId: a.id, text: "Sa propre sous-tâche" });
    const perso = await commands.createSubject({
      name: "Perso",
      color: null,
      rootPath: null,
      parentId: null,
    });
    await commands.createTask({
      title: "Renouveler le passeport",
      description: null,
      subjectId: perso.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    useUi.getState().setView({ kind: "subject", subjectId: globex });
    useUi.getState().openTask(a.id);
    const user = userEvent.setup();
    render(<App />);
    const relations = await openFold(document.body, "Relations", "Lien");
    const menu = within(relations).getByRole("region", {
      name: "Lier une tâche",
    });
    const options = async () =>
      (await within(menu).findAllByRole("option")).map((o) =>
        o.textContent?.replace(/\s+/g, " ").trim(),
      );
    // The task's own project, open; Perso folded; never the task nor its own subtask.
    expect(await options()).toEqual(["Exporter les temps▸ 2"]);
    expect(
      within(menu).getByRole("button", { name: "Perso, 1 tâche" }),
    ).toHaveAttribute("aria-expanded", "false");
    // « ▸ 2 » unfolds the subtasks; → and ← at the keyboard too.
    await user.click(
      within(menu).getByRole("button", {
        name: "Afficher les 2 sous-tâches de « Exporter les temps »",
      }),
    );
    expect(await options()).toEqual([
      "Exporter les temps▾ 2",
      "Arrondir les durées",
      "Choisir les colonnes",
    ]);
    await user.keyboard("{ArrowLeft}");
    expect(await options()).toEqual(["Exporter les temps▸ 2"]);
    await user.keyboard("{ArrowRight}{ArrowDown}");
    // Tab picks the kind of link, Entrée links the active line.
    await user.keyboard("{Tab}");
    expect(within(menu).getByRole("radio", { name: "Bloque" })).toBeChecked();
    await user.keyboard("{Enter}");
    await waitFor(async () =>
      expect((await commands.getTask(a.id)).relations.blocks[0]?.title).toBe(
        "Arrondir les durées",
      ),
    );
    // A linked subtask reads « Tâche › Sous-tâche ».
    expect(
      await within(relations).findByText("Exporter les temps ›", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("finds a subtask by its name and shows it under its task", async () => {
    const a = await taskWithFolder("Rapport mensuel");
    const migration = await commands.createTask({
      title: "Migration",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await commands.addSubtask({
      taskId: migration.id,
      text: "Script de reprise",
    });
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: a.subject?.id ?? null });
    useUi.getState().openTask(a.id);
    const user = userEvent.setup();
    render(<App />);
    const relations = await openFold(document.body, "Relations", "Lien");
    const menu = within(relations).getByRole("region", {
      name: "Lier une tâche",
    });
    await user.type(within(menu).getByRole("combobox"), "script");
    const found = await within(menu).findAllByRole("option");
    expect(found.map((o) => o.textContent)).toEqual([
      "Migration",
      "Script de reprise",
    ]);
    await user.keyboard("{Escape}");
    expect(
      within(relations).queryByRole("region", { name: "Lier une tâche" }),
    ).toBeNull();
    expect(
      within(relations).getByRole("button", { name: "+ Lier une tâche" }),
    ).toBeInTheDocument();
  });

  it("shows where each file stands with the account on its tile", async () => {
    const task = await taskWithFolder("Export PDF");
    await commands.addAttachments({
      taskId: task.id,
      paths: [
        "/Users/user/maquette.png",
        "/Users/user/devis.pdf",
        "/Users/user/film.mov",
        "/Users/user/rush.mov",
        "/Users/user/photo.jpg",
        "/Users/user/plan.pdf",
      ],
    });
    // Without an account, tiles look as before file sync.
    let detail = await commands.getTask(task.id);
    expect(detail.attachments.map((a) => a.remote)).toEqual(
      Array(6).fill("none"),
    );
    await commands.syncLogin({
      serverUrl: "https://taido.example.fr",
      email: "user@exemple.fr",
      password: "un mot de passe assez long",
    });
    detail = await commands.getTask(task.id);
    expect(detail.attachments.map((a) => a.remote)).toEqual(
      Array(6).fill("local_only"),
    );
    const [, sending, big, full, elsewhere, fetching] = detail.attachments;
    backend().links.setRemote(sending.id, "uploading");
    backend().links.setRemote(big.id, "too_large");
    backend().links.setRemote(full.id, "quota_full");
    backend().links.setRemote(elsewhere.id, "to_download");
    backend().links.setRemote(fetching.id, "downloading");
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: task.subject?.id ?? null });
    useUi.getState().openTask(task.id);
    render(<App />);
    const panel = await openFold(document.body, "Pièces jointes", "Fichier");
    const tile = (name: string) =>
      within(panel).getByRole("button", { name: `Options de « ${name} »` });
    expect(
      within(tile("maquette.png")).getByText("Sur cet appareil seulement"),
    ).toBeInTheDocument();
    expect(within(tile("devis.pdf")).getByText("Envoi…")).toBeInTheDocument();
    expect(
      within(tile("film.mov")).getByText("Trop gros pour le serveur"),
    ).toHaveClass("text-due-overdue");
    expect(
      within(tile("rush.mov")).getByText("Espace du compte plein"),
    ).toHaveClass("text-due-overdue");
    expect(
      within(tile("photo.jpg")).getByText("À télécharger"),
    ).toBeInTheDocument();
    expect(
      within(tile("plan.pdf")).getByText("Téléchargement…"),
    ).toBeInTheDocument();
    // A file still to download is not « introuvable »: its size shows.
    expect(
      within(tile("photo.jpg")).queryByText("fichier introuvable"),
    ).toBeNull();
    expect(within(tile("photo.jpg")).getByText("1 Ko")).toBeInTheDocument();

    // After a sync: the files that were only here are sent, nothing to show.
    await commands.syncNow();
    detail = await commands.getTask(task.id);
    expect(detail.attachments[0].remote).toBe("none");
    await waitFor(() =>
      expect(
        within(tile("maquette.png")).queryByText("Sur cet appareil seulement"),
      ).toBeNull(),
    );
    expect(within(tile("film.mov")).getByText("Trop gros pour le serveur"));

    // Unlinked again: no tile says anything.
    await commands.syncUnlink();
    detail = await commands.getTask(task.id);
    expect(detail.attachments.every((a) => a.remote === "none")).toBe(true);
  });
});
