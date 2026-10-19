/**
 * The « Notes » tab of a project on the Mac: the
 * page list (Épinglées, pages outside any group, groups, Résumés de tâches), the groups'
 * renaming and deletion, the page menu, the list search, the empty state.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { NoteKind } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function project(name = "Taido") {
  const s = await backend().commands.createSubject({
    name,
    color: null,
    rootPath: null,
    parentId: null,
  });
  return s.id;
}

function page(
  subjectId: string,
  title: string,
  options: { groupId?: string; body?: string; kind?: NoteKind } = {},
) {
  return backend().commands.createNotePage({
    subjectId,
    groupId: options.groupId ?? null,
    title,
    body: options.body ?? "",
    kind: options.kind ?? "page",
    sourceTaskId: null,
  });
}

/** A project with one page in each part of the notebook. */
async function fullNotebook() {
  const subjectId = await project();
  const decisions = await backend().commands.createNoteGroup({
    subjectId,
    name: "Décisions",
  });
  const mails = await page(subjectId, "Style des mails", {
    groupId: decisions.id,
    body: "Style « Bleu nuit » pour tous les mails.",
  });
  const server = await page(subjectId, "Serveur et accès");
  await backend().commands.moveNotePage({
    id: server.id,
    target: "pinned",
    index: null,
  });
  const loose = await page(subjectId, "Idées en vrac", {
    body: "Une appli Android native un jour.",
  });
  const summary = await page(subjectId, "Connexion Google", {
    kind: "summary",
  });
  return { subjectId, decisions, mails, server, loose, summary };
}

async function openNotes(subjectId: string) {
  act(() => {
    useUi.getState().setView({ kind: "subject", subjectId });
    useUi.getState().setProjectTab("notes");
  });
  render(<App />);
  return screen.findByRole("navigation", { name: fr.notes.listLabel });
}

/** Names of the list's blocks, in order, and their page titles. */
function blocks(list: HTMLElement) {
  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-note-block]"),
  ).map((b) => ({
    name: b.getAttribute("aria-label"),
    pages: Array.from(
      b.querySelectorAll<HTMLElement>("[data-note-page] [data-note-title]"),
    ).map((t) => t.textContent),
  }));
}

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("« Notes » tab", () => {
  it("is the last tab of a project", async () => {
    const subjectId = await project();
    await page(subjectId, "Serveur et accès");
    act(() => useUi.getState().setView({ kind: "subject", subjectId }));
    render(<App />);
    const tabs = await screen.findByRole("tablist", { name: fr.board.tabs });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual([fr.board.list, fr.board.board, fr.dashboard.tab, fr.notes.tab]);
    await userEvent.click(
      within(tabs).getByRole("tab", { name: fr.notes.tab }),
    );
    expect(useUi.getState().projectTab).toBe("notes");
    expect(
      await screen.findByRole("navigation", { name: fr.notes.listLabel }),
    ).toBeInTheDocument();
  });

  it("« Sans projet » has no notebook: no tab, and a remembered Notes tab shows the list", async () => {
    await project();
    await backend().commands.createTask({
      title: "Acheter du pain",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    act(() => {
      useUi.getState().setView({ kind: "inbox", subjectId: null });
      useUi.getState().setProjectTab("notes");
    });
    render(<App />);
    const tabs = await screen.findByRole("tablist", { name: fr.board.tabs });
    expect(within(tabs).queryByRole("tab", { name: fr.notes.tab })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: fr.notes.listLabel }),
    ).toBeNull();
  });

  it("lists Épinglées, the pages outside any group, the groups, then Résumés de tâches", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: fr.notes.pinned, pages: ["Serveur et accès"] },
        { name: fr.notes.ungrouped, pages: ["Idées en vrac"] },
        { name: "Décisions", pages: ["Style des mails"] },
        { name: fr.notes.summaries, pages: ["Connexion Google"] },
      ]),
    );
    // Only real groups have a menu; the fixed ones (and the loose pages) have none.
    expect(
      within(list).getByRole("button", {
        name: fr.notes.groupMenu("Décisions"),
      }),
    ).toBeInTheDocument();
    expect(
      within(list).queryByRole("button", {
        name: fr.notes.groupMenu(fr.notes.pinned),
      }),
    ).toBeNull();
    expect(
      within(list).queryByRole("button", {
        name: fr.notes.groupMenu(fr.notes.summaries),
      }),
    ).toBeNull();
    // The summary carries its badge.
    const summaryRow = within(list)
      .getByText("Connexion Google")
      .closest("[data-note-page]") as HTMLElement;
    expect(summaryRow).toHaveTextContent(fr.notes.summaryBadge);
  });

  it("opens on the first page, then on the last page opened in this project", async () => {
    const { subjectId, mails } = await fullNotebook();
    const list = await openNotes(subjectId);
    const pane = () => screen.getByRole("region", { name: fr.notes.pageLabel });
    expect(
      await screen.findByDisplayValue("Serveur et accès"),
    ).toBeInTheDocument();
    await userEvent.click(within(list).getByText("Style des mails"));
    expect(
      await screen.findByDisplayValue("Style des mails"),
    ).toBeInTheDocument();
    expect(pane()).toHaveTextContent(
      "Style « Bleu nuit » pour tous les mails.",
    );
    expect(pane()).toHaveTextContent("Taido › Décisions");
    expect(useUi.getState().lastNotePage[subjectId]).toBe(mails.id);
    expect(
      within(list).getByText("Style des mails").closest("button"),
    ).toHaveAttribute("aria-current", "page");
  });

  it("folds a group and remembers it", async () => {
    const { subjectId, decisions } = await fullNotebook();
    const list = await openNotes(subjectId);
    const toggle = await within(list).findByRole("button", {
      name: fr.notes.toggleGroup("Décisions", true),
    });
    await userEvent.click(toggle);
    expect(within(list).queryByText("Style des mails")).toBeNull();
    expect(useUi.getState().foldedNoteGroups[decisions.id]).toBe(true);
  });

  it("renames a group in place: double click, Enter saves, Escape cancels, empty refused", async () => {
    const { subjectId, decisions } = await fullNotebook();
    const update = vi.spyOn(commands, "updateNoteGroup");
    const list = await openNotes(subjectId);
    const title = await within(list).findByText("Décisions");

    // Escape cancels.
    await userEvent.dblClick(title);
    let field = within(list).getByRole("textbox", { name: fr.notes.groupName });
    await userEvent.clear(field);
    await userEvent.type(field, "Choix{Escape}");
    expect(update).not.toHaveBeenCalled();
    expect(within(list).getByText("Décisions")).toBeInTheDocument();

    // An empty name is refused: the field closes, nothing is saved.
    await userEvent.dblClick(within(list).getByText("Décisions"));
    field = within(list).getByRole("textbox", { name: fr.notes.groupName });
    await userEvent.clear(field);
    await userEvent.type(field, "{Enter}");
    expect(update).not.toHaveBeenCalled();

    // Enter saves.
    await userEvent.dblClick(within(list).getByText("Décisions"));
    field = within(list).getByRole("textbox", { name: fr.notes.groupName });
    await userEvent.clear(field);
    await userEvent.type(field, "Choix{Enter}");
    expect(update).toHaveBeenCalledWith({ id: decisions.id, name: "Choix" });
    expect(await within(list).findByText("Choix")).toBeInTheDocument();
  });

  it("adds a group and a page", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    await userEvent.click(
      await within(list).findByRole("button", { name: fr.notes.newGroup }),
    );
    const field = within(list).getByRole("textbox", {
      name: fr.notes.groupName,
    });
    await userEvent.type(field, "Accès{Enter}");
    await waitFor(() =>
      expect(blocks(list).map((b) => b.name)).toContain("Accès"),
    );

    await userEvent.click(
      within(list).getByRole("button", { name: fr.notes.newPage }),
    );
    // The new page opens, its title selected for typing.
    const title = await screen.findByDisplayValue(fr.notes.untitled);
    expect(title).toHaveFocus();
    // Typing replaces the selected « Sans titre ».
    await userEvent.keyboard("Mots de passe{Enter}");
    await waitFor(async () => {
      const nb = await backend().commands.notebook(subjectId);
      expect(nb.ungrouped.map((p) => p.title)).toContain("Mots de passe");
    });
  });

  it("deletes a group after a confirmation; its pages stay, outside any group", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    await userEvent.click(
      await within(list).findByRole("button", {
        name: fr.notes.groupMenu("Décisions"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: fr.common.delete }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: fr.notes.deleteGroupTitle("Décisions"),
    });
    expect(confirm).toHaveTextContent(fr.notes.deleteGroupText);
    await userEvent.click(
      within(confirm).getByRole("button", { name: fr.common.delete }),
    );
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: fr.notes.pinned, pages: ["Serveur et accès"] },
        {
          name: fr.notes.ungrouped,
          pages: ["Idées en vrac", "Style des mails"],
        },
        { name: fr.notes.summaries, pages: ["Connexion Google"] },
      ]),
    );
  });

  it("page menu: pin, move to a group, duplicate, delete with « Annuler »", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    const menuOf = async (title: string) => {
      await userEvent.click(
        await within(list).findByRole("button", {
          name: fr.notes.pageMenu(title),
        }),
      );
      return screen.findByRole("menu");
    };

    // Épingler.
    let menu = await menuOf("Idées en vrac");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual([
      fr.notes.pin,
      fr.notes.moveTo,
      fr.notes.duplicate,
      fr.common.delete,
    ]);
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: fr.notes.pin }),
    );
    await waitFor(() =>
      expect(blocks(list)[0]).toEqual({
        name: fr.notes.pinned,
        pages: ["Serveur et accès", "Idées en vrac"],
      }),
    );

    // Désépingler puts it back where it was.
    menu = await menuOf("Idées en vrac");
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: fr.notes.unpin }),
    );
    await waitFor(() =>
      expect(blocks(list)[1]).toEqual({
        name: fr.notes.ungrouped,
        pages: ["Idées en vrac"],
      }),
    );

    // Déplacer vers › Décisions.
    menu = await menuOf("Idées en vrac");
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: fr.notes.moveTo }),
    );
    const targets = await screen.findByRole("menu", {
      name: fr.notes.moveToLabel("Idées en vrac"),
    });
    expect(
      within(targets)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Décisions"]);
    await userEvent.click(
      within(targets).getByRole("menuitem", { name: "Décisions" }),
    );
    await waitFor(() =>
      expect(blocks(list).find((b) => b.name === "Décisions")?.pages).toEqual([
        "Style des mails",
        "Idées en vrac",
      ]),
    );

    // Dupliquer.
    menu = await menuOf("Style des mails");
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: fr.notes.duplicate }),
    );
    // The copy comes right after the original, and opens.
    await waitFor(() =>
      expect(blocks(list).find((b) => b.name === "Décisions")?.pages).toEqual([
        "Style des mails",
        "Style des mails (copie)",
        "Idées en vrac",
      ]),
    );
    expect(
      await screen.findByDisplayValue("Style des mails (copie)"),
    ).toBeInTheDocument();
    const copy = (
      await backend().commands.notebook(subjectId)
    ).groups[0].pages.find((p) => p.title === "Style des mails (copie)");
    expect(copy?.excerpt).toBe("Style « Bleu nuit » pour tous les mails.");

    // Supprimer, then « Annuler ».
    menu = await menuOf("Style des mails");
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: fr.common.delete }),
    );
    await waitFor(() =>
      expect(within(list).queryByText("Style des mails")).toBeNull(),
    );
    const toast = await screen.findByText(fr.notes.deleted);
    await userEvent.click(
      within(toast.closest("[role=status]") as HTMLElement).getByRole(
        "button",
        {
          name: fr.toast.undo,
        },
      ),
    );
    expect(
      await within(list).findByText("Style des mails"),
    ).toBeInTheDocument();
  });

  it("search filters the list on title and text, and says when nothing matches", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    const field = await within(list).findByRole("searchbox", {
      name: fr.notes.search,
    });
    await userEvent.type(field, "bleu");
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: "Décisions", pages: ["Style des mails"] },
      ]),
    );
    await userEvent.clear(field);
    await userEvent.type(field, "serveur");
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: fr.notes.pinned, pages: ["Serveur et accès"] },
      ]),
    );
    await userEvent.clear(field);
    await userEvent.type(field, "zzz");
    expect(
      await within(list).findByText(fr.notes.noMatch("zzz")),
    ).toBeInTheDocument();
  });

  it("a failed search says so, with « Réessayer », instead of leaving the list unfiltered", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    const field = await within(list).findByRole("searchbox", {
      name: fr.notes.search,
    });
    const real = commands.searchNotes.bind(commands);
    let down = true;
    const search = vi
      .spyOn(commands, "searchNotes")
      .mockImplementation((...args) =>
        down
          ? Promise.reject({ kind: "internal", message: "boom" })
          : real(...args),
      );
    await userEvent.type(field, "bleu");
    expect(
      await within(list).findByText(fr.notes.searchFailed),
    ).toBeInTheDocument();
    down = false;
    await userEvent.click(
      within(list).getByRole("button", { name: fr.notes.searchRetry }),
    );
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: "Décisions", pages: ["Style des mails"] },
      ]),
    );
    expect(
      within(list).queryByText(fr.notes.searchFailed),
    ).not.toBeInTheDocument();
    expect(search).toHaveBeenCalled();
  });

  it("search reads whole pages, past the excerpt (the core's search, I4)", async () => {
    const { subjectId } = await fullNotebook();
    await page(subjectId, "Longue", {
      body: `${"mot ".repeat(60)}licorne`,
    });
    const list = await openNotes(subjectId);
    const field = await within(list).findByRole("searchbox", {
      name: fr.notes.search,
    });
    await userEvent.type(field, "licorne");
    await waitFor(() =>
      expect(blocks(list)).toEqual([
        { name: fr.notes.ungrouped, pages: ["Longue"] },
      ]),
    );
  });

  it("empty project: the empty state, with Claude's line on the Mac, and « Nouvelle page »", async () => {
    const subjectId = await project();
    act(() => {
      useUi.getState().setView({ kind: "subject", subjectId });
      useUi.getState().setProjectTab("notes");
    });
    render(<App />);
    expect(await screen.findByText(fr.notes.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(fr.notes.emptyText)).toBeInTheDocument();
    expect(screen.getByText(fr.notes.emptyClaude)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: fr.notes.newPage }),
    );
    const pane = await screen.findByRole("region", {
      name: fr.notes.pageLabel,
    });
    expect(
      await within(pane).findByDisplayValue(fr.notes.untitled),
    ).toHaveFocus();
  });

  it("the title holds at most 500 bytes: accented letters count double", async () => {
    const { subjectId } = await fullNotebook();
    await openNotes(subjectId);
    const title = await screen.findByDisplayValue("Serveur et accès");
    fireEvent.change(title, { target: { value: "é".repeat(300) } });
    expect(title).toHaveValue("é".repeat(250));
  });
});

describe("« Notes » tab, final review fixes", () => {
  it("Enter in the title saves it and goes on at the start of the text", async () => {
    const { subjectId, server } = await fullNotebook();
    await openNotes(subjectId);
    const title = await screen.findByDisplayValue("Serveur et accès");
    await userEvent.clear(title);
    await userEvent.type(title, "Accès serveur{Enter}");
    await waitFor(async () =>
      expect((await commands.getNotePage(server.id)).title).toBe(
        "Accès serveur",
      ),
    );
    const text = screen.getByRole("textbox", {
      name: fr.notes.editor.bodyLabel,
    }) as HTMLElement & {
      editor?: { isFocused: boolean; state: { selection: { from: number } } };
    };
    await waitFor(() => expect(text.editor?.isFocused).toBe(true));
    expect(text.editor?.state.selection.from).toBe(1);
  });

  it("a folded group says how many pages it hides", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    await userEvent.click(
      await within(list).findByRole("button", {
        name: fr.notes.toggleGroup("Décisions", true),
      }),
    );
    expect(within(list).getByText(fr.notes.pageCount(1))).toBeInTheDocument();
  });

  it("the group menu offers « Nouvelle page ici »", async () => {
    const { subjectId, decisions } = await fullNotebook();
    const list = await openNotes(subjectId);
    await userEvent.click(
      await within(list).findByRole("button", {
        name: fr.notes.groupMenu("Décisions"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: fr.notes.newPageHere }),
    );
    await waitFor(async () => {
      const nb = await commands.notebook(subjectId);
      const g = nb.groups.find((x) => x.group.id === decisions.id);
      expect(g?.pages.map((p) => p.title)).toEqual([
        "Style des mails",
        fr.notes.untitled,
      ]);
    });
  });

  it("the « … » of a row and of a group hide only where there is a hover", async () => {
    const { subjectId } = await fullNotebook();
    const list = await openNotes(subjectId);
    const groupMore = await within(list).findByRole("button", {
      name: fr.notes.groupMenu("Décisions"),
    });
    expect(groupMore.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(groupMore).not.toHaveClass("opacity-0");
    const rowMore = within(list).getByRole("button", {
      name: fr.notes.pageMenu("Idées en vrac"),
    });
    expect(rowMore.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(rowMore).not.toHaveClass("opacity-0");
  });

  it("groups but no page: the right side says what to do, with « Nouvelle page »", async () => {
    const subjectId = await project();
    await backend().commands.createNoteGroup({ subjectId, name: "Décisions" });
    await openNotes(subjectId);
    expect(await screen.findByText(fr.notes.noPageOpen)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: fr.notes.newPage });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(
      await screen.findByDisplayValue(fr.notes.untitled),
    ).toBeInTheDocument();
  });

  it("a page that cannot be read offers « Réessayer »", async () => {
    const { subjectId } = await fullNotebook();
    const get = vi
      .spyOn(commands, "getNotePage")
      .mockRejectedValueOnce({ kind: "internal", message: "boom" });
    await openNotes(subjectId);
    const alert = await screen.findByText(fr.notes.pageError);
    const retry = within(
      alert.closest("[role=alert]") as HTMLElement,
    ).getByRole("button", { name: fr.list.retry });
    await userEvent.click(retry);
    expect(
      await screen.findByDisplayValue("Serveur et accès"),
    ).toBeInTheDocument();
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
