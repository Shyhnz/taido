// The « Notes » tab on the phone (IS_MOBILE forced on, a 390 px screen): the list full width,
// a page as a full-screen sheet closed by « ‹ Notes » or Android's back, the floating « + ».
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fr } from "../../i18n/fr";
import type { Phone } from "../../mobile/test/helpers";

vi.mock("../../lib/target", () => ({ IS_MOBILE: true }));

/** Resolves on the next `popstate` (`history.go` delivers it a few tasks later). */
function nextPopState(): Promise<void> {
  return new Promise((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );
}

let phone: Phone;
let MobileApp: typeof import("../../mobile/MobileApp").default;
let ui: typeof import("../../stores/ui");

beforeAll(async () => {
  const helpers = await import("../../mobile/test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("../../mobile/MobileApp")).default;
  ui = await import("../../stores/ui");
});

beforeEach(() => {
  phone.backend.reset({ seed: false });
  ui.resetUi();
});

async function project() {
  const s = await phone.backend.commands.createSubject({
    name: "Taido",
    color: null,
    rootPath: null,
    parentId: null,
  });
  return s.id;
}

async function openNotes(subjectId: string) {
  act(() => {
    ui.useUi.getState().setView({ kind: "subject", subjectId });
    ui.useUi.getState().toggleSidebar(false);
    ui.useUi.getState().setProjectTab("notes");
  });
  render(<MobileApp backend={phone.backend} />);
  return screen.findByRole("main");
}

describe("« Notes » on the phone", () => {
  it("a tap opens the page as a full-screen sheet; « ‹ Notes » and Android's back close it", async () => {
    const subjectId = await project();
    const decisions = await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    await phone.backend.commands.createNotePage({
      subjectId,
      groupId: decisions.id,
      title: "Style des mails",
      body: "Style « Bleu nuit » pour tous les mails.",
      kind: "page",
      sourceTaskId: null,
    });
    const main = await openNotes(subjectId);
    const list = await within(main).findByRole("navigation", {
      name: fr.notes.listLabel,
    });
    // The list alone: no page beside it.
    expect(
      screen.queryByRole("region", { name: fr.notes.pageLabel }),
    ).toBeNull();
    const row = within(list)
      .getByText("Style des mails")
      .closest("[data-note-page]") as HTMLElement;
    // A 48 px touch target, with the start of the text under the title.
    expect(row).toHaveClass("min-h-12");
    expect(row).toHaveTextContent("Style « Bleu nuit » pour tous les mails.");

    await userEvent.click(row);
    const sheet = await screen.findByRole("dialog", {
      name: "Style des mails",
    });
    expect(main).not.toBeVisible();
    // Reading first: opening an existing page does not raise the keyboard.
    const title = within(sheet).getByRole("textbox", {
      name: fr.notes.titleLabel,
    });
    expect(title).not.toHaveFocus();
    expect(sheet).toHaveTextContent(`Décisions`);
    // The focus is on « ‹ Notes » (no field, so no keyboard).
    expect(
      within(sheet).getByRole("button", { name: fr.notes.backLabel }),
    ).toHaveFocus();

    // « ‹ Notes » closes it.
    let popped = nextPopState();
    await userEvent.click(
      within(sheet).getByRole("button", { name: fr.notes.backLabel }),
    );
    expect(ui.useUi.getState().notePageSheet).toBeNull();
    await act(() => popped);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Back on the row that opened it.
    await waitFor(() =>
      expect(
        within(list).getByText("Style des mails").closest("[data-note-page]"),
      ).toHaveFocus(),
    );

    // Android's back closes it too.
    await userEvent.click(
      within(list)
        .getByText("Style des mails")
        .closest("[data-note-page]") as HTMLElement,
    );
    await screen.findByRole("dialog", { name: "Style des mails" });
    popped = nextPopState();
    act(() => window.history.back());
    await act(() => popped);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ui.useUi.getState().notePageSheet).toBeNull();
  });

  it("the floating « + » creates a page in the topmost open group and opens it, title ready to type", async () => {
    const subjectId = await project();
    const folded = await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Archives",
    });
    const decisions = await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    act(() =>
      ui.useUi
        .getState()
        .toggleNoteGroup(
          ui.noteFoldKey(subjectId, { group: folded.id }),
          false,
        ),
    );
    await openNotes(subjectId);
    await screen.findByRole("navigation", { name: fr.notes.listLabel });
    await userEvent.click(
      screen.getByRole("button", { name: fr.notes.newPage }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: fr.notes.untitled,
    });
    const title = within(sheet).getByRole("textbox", {
      name: fr.notes.titleLabel,
    });
    await waitFor(() => expect(title).toHaveFocus());
    // 16 px at least: no automatic zoom on focus.
    expect(title).toHaveClass("text-[22px]");
    const nb = await phone.backend.commands.notebook(subjectId);
    expect(
      nb.groups.find((g) => g.group.id === decisions.id)?.pages,
    ).toHaveLength(1);
  });

  it("the floating « + » still adds a task on the list tab", async () => {
    const subjectId = await project();
    act(() => {
      ui.useUi.getState().setView({ kind: "subject", subjectId });
      ui.useUi.getState().toggleSidebar(false);
    });
    render(<MobileApp backend={phone.backend} />);
    expect(
      await screen.findByRole("button", { name: fr.sidebar.newTask }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: fr.notes.newPage })).toBeNull();
  });

  it("empty project: the empty state without Claude's line", async () => {
    const subjectId = await project();
    await openNotes(subjectId);
    expect(await screen.findByText(fr.notes.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(fr.notes.emptyText)).toBeInTheDocument();
    expect(screen.queryByText(fr.notes.emptyClaude)).toBeNull();
    // One « Nouvelle page »: the floating « + », not a second button in the content.
    expect(
      screen.getAllByRole("button", { name: fr.notes.newPage }),
    ).toHaveLength(1);
  });

  it("a group is renamed in a small dialog, not in place", async () => {
    const subjectId = await project();
    await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    const main = await openNotes(subjectId);
    const list = await within(main).findByRole("navigation", {
      name: fr.notes.listLabel,
    });
    fireEvent.doubleClick(await within(list).findByText("Décisions"));
    expect(within(list).queryByRole("textbox")).toBeNull();
    await userEvent.click(
      within(list).getByRole("button", {
        name: fr.notes.groupMenu("Décisions"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: fr.notes.rename }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: fr.notes.renameGroup,
    });
    const field = within(dialog).getByRole("textbox", {
      name: fr.notes.groupName,
    });
    await userEvent.clear(field);
    await userEvent.type(field, "Choix{Enter}");
    expect(await within(list).findByText("Choix")).toBeInTheDocument();
  });

  it("a ⌘K note hit opens the page's sheet", async () => {
    const subjectId = await project();
    const p = await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Serveur et accès",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    act(() => ui.useUi.getState().toggleSidebar(false));
    render(<MobileApp backend={phone.backend} />);
    const { goToNote } = await import("../search/SearchDialog");
    act(() =>
      goToNote({
        id: p.id,
        subject: { id: subjectId, name: "Taido", color: "teal" },
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Serveur et accès" }),
    ).toBeInTheDocument();
  });

  it("« Dupliquer » from the sheet opens the copy in the sheet", async () => {
    const subjectId = await project();
    await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Serveur et accès",
      body: "SSH par clé.",
      kind: "page",
      sourceTaskId: null,
    });
    const main = await openNotes(subjectId);
    await userEvent.click(
      (await within(main).findByText("Serveur et accès")).closest(
        "[data-note-page]",
      ) as HTMLElement,
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Serveur et accès",
    });
    await userEvent.click(
      within(sheet).getByRole("button", {
        name: fr.notes.pageMenu("Serveur et accès"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: fr.notes.duplicate }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Serveur et accès (copie)" }),
    ).toBeInTheDocument();
    expect(ui.useUi.getState().lastNotePage[subjectId]).toBe(
      ui.useUi.getState().notePageSheet,
    );
  });
});

describe("long press on a page (task 6)", () => {
  beforeEach(async () => {
    const { useMenuStore } = await import("../../components/Menu");
    useMenuStore.setState({ menu: null });
  });

  async function onePage() {
    const subjectId = await project();
    await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Idées",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    const main = await openNotes(subjectId);
    return (await within(main).findByText("Idées")).closest(
      "[data-note-page]",
    ) as HTMLElement;
  }

  const subjectIdOf = (_row: HTMLElement) =>
    ui.useUi.getState().view.subjectId as string;

  const touch = (x: number, y: number) => ({
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
  });
  const hold = () => new Promise((r) => setTimeout(r, 380));

  it("held without moving, it opens the page's menu on release", async () => {
    const row = await onePage();
    const before = await phone.backend.commands.notebook(subjectIdOf(row));
    fireEvent.touchStart(row, touch(40, 40));
    await act(hold);
    // The browser's own long-press menu is not the page's menu.
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.touchEnd(row, touch(40, 40));
    expect(
      await screen.findByRole("menu", { name: fr.notes.pageMenu("Idées") }),
    ).toBeInTheDocument();
    // Only the menu: the page did not move, even if a drop place is under the finger.
    expect(await phone.backend.commands.notebook(subjectIdOf(row))).toEqual(
      before,
    );
  });

  it("held then moved, it is dragged: no menu", async () => {
    const row = await onePage();
    fireEvent.touchStart(row, touch(40, 40));
    await act(hold);
    fireEvent.touchMove(row, touch(40, 120));
    // A browser paints between the finger's move and its lift.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    fireEvent.touchEnd(row, touch(40, 120));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an empty « Épinglées » stays, with a short line, and no « Sans groupe » zone", async () => {
    const subjectId = await project();
    const decisions = await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    await phone.backend.commands.createNotePage({
      subjectId,
      groupId: decisions.id,
      title: "Style",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    const main = await openNotes(subjectId);
    const pinned = await within(main).findByRole("region", {
      name: fr.notes.pinned,
    });
    expect(pinned).toHaveTextContent(fr.notes.pinnedEmptyPhone);
    expect(
      within(main).queryByRole("region", { name: fr.notes.ungrouped }),
    ).toBeNull();
  });

  it("a quick tap still opens the page", async () => {
    const row = await onePage();
    await userEvent.click(row);
    expect(
      await screen.findByRole("dialog", { name: "Idées" }),
    ).toBeInTheDocument();
  });
});

describe("the page's text on the phone (task 7, fix round 1)", () => {
  it("« Mentionné dans » lines and the `[[` list are 44 px touch targets", async () => {
    const subjectId = await project();
    const target = await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Cible",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Source",
      body: `Voir [[page:${target.id}|Cible]]`,
      kind: "page",
      sourceTaskId: null,
    });
    await openNotes(subjectId);
    act(() => ui.useUi.getState().openNotePage(subjectId, target.id, true));
    const sheet = await screen.findByRole("dialog", { name: "Cible" });
    const mentions = await within(sheet).findByRole("region", {
      name: fr.notes.mentionedIn,
    });
    expect(
      await within(mentions).findByRole("button", { name: /Source/ }),
    ).toHaveClass("min-h-11");

    const text = within(sheet).getByRole("textbox", {
      name: fr.notes.editor.bodyLabel,
    }) as HTMLElement & { editor?: import("@tiptap/core").Editor };
    act(() => {
      text.editor?.commands.focus("end");
      text.editor?.commands.insertContent("[[So");
    });
    const list = await screen.findByRole("listbox", {
      name: fr.notes.editor.linkSuggest,
    });
    for (const option of within(list).getAllByRole("option")) {
      expect(option).toHaveClass("min-h-11");
    }
  });

  it("a group's chevron and name are one 44 px target; its « … » is apart", async () => {
    const subjectId = await project();
    await phone.backend.commands.createNoteGroup({
      subjectId,
      name: "Décisions",
    });
    const main = await openNotes(subjectId);
    const list = await within(main).findByRole("navigation", {
      name: fr.notes.listLabel,
    });
    const toggle = within(list).getByRole("button", {
      name: fr.notes.toggleGroup("Décisions", true),
    });
    expect(toggle).toHaveClass("h-11");
    expect(toggle).toHaveTextContent("Décisions");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const more = within(list).getByRole("button", {
      name: fr.notes.groupMenu("Décisions"),
    });
    expect(more).toHaveClass("h-11", "w-11");
    expect(toggle.contains(more)).toBe(false);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("the project tabs are 44 px targets on the phone", async () => {
    const subjectId = await project();
    await openNotes(subjectId);
    const tabs = await screen.findByRole("tablist", { name: fr.board.tabs });
    for (const tab of within(tabs).getAllByRole("tab")) {
      expect(tab).toHaveClass("h-11");
    }
  });

  it("the sheet shows the page's shape while it is read", async () => {
    const subjectId = await project();
    const p = await phone.backend.commands.createNotePage({
      subjectId,
      groupId: null,
      title: "Lente",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    let release = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const get = phone.backend.commands.getNotePage;
    const spy = vi
      .spyOn(phone.backend.commands, "getNotePage")
      .mockImplementation(async (id) => {
        await slow;
        return get(id);
      });
    await openNotes(subjectId);
    act(() => ui.useUi.getState().openNotePage(subjectId, p.id, true));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByRole("status", { name: fr.common.loading }),
    ).toBeInTheDocument();
    release();
    expect(await within(sheet).findByDisplayValue("Lente")).toBeInTheDocument();
    spy.mockRestore();
  });
});
