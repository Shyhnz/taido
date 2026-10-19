/**
 * The page editor on the Mac: saved 600 ms after
 * the last keystroke and never when nothing was typed (§ 5.1), shortcuts, `[[` links to the
 * project's pages and tasks, link chips with the current title, the size limit (§ 5.4),
 * « Mentionné dans » under the page and in the task panel.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../App";
import { useToasts } from "../../../components/Toast";
import { fr } from "../../../i18n/fr";
import { commands, mockBackend } from "../../../lib/ipc";
import { MAX_NOTE_BODY_BYTES } from "../../../lib/sync-proto";
import { resetUi, useUi } from "../../../stores/ui";
import {
  deleteNotePage,
  forgetDeletedHere,
  pageMenuItems,
} from "../noteActions";
import { forgetNoteDrafts, noteDraft } from "./pendingEdits";

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

function page(subjectId: string, title: string, body = "") {
  return backend().commands.createNotePage({
    subjectId,
    groupId: null,
    title,
    body,
    kind: "page",
    sourceTaskId: null,
  });
}

function task(
  subjectId: string,
  title: string,
  description: string | null = null,
) {
  return backend().commands.createTask({
    title,
    description,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

async function openPage(subjectId: string, pageId: string) {
  act(() => {
    useUi.getState().setView({ kind: "subject", subjectId });
    useUi.getState().setProjectTab("notes");
    useUi.getState().openNotePage(subjectId, pageId, false);
  });
  render(<App />);
  return body();
}

/** The page's text area, and its Tiptap editor (what the keyboard would drive). */
async function body() {
  const el = await screen.findByRole("textbox", {
    name: fr.notes.editor.bodyLabel,
  });
  const editor = (el as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error("no editor on the page's text");
  return { el, editor };
}

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  backend().reset({ seed: false });
  // The mock backend gives the same ids again after a reset.
  forgetNoteDrafts();
  forgetDeletedHere();
  resetUi();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving", () => {
  it("sends the text once, 600 ms after the last keystroke", async () => {
    const s = await project();
    const p = await page(s, "Serveur", "Accès SSH.");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" Port 22");
    });
    await wait(300);
    act(() => {
      editor.commands.insertContent(".");
    });
    await wait(400);
    // 400 ms after the last key: still waiting.
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({
      id: p.id,
      title: null,
      body: "Accès SSH. Port 22.",
    });
    expect((await backend().commands.getNotePage(p.id)).body).toBe(
      "Accès SSH. Port 22.",
    );
  });

  it("typing a sentence makes one save and one `notes` event, not one per key", async () => {
    const s = await project();
    const p = await page(s, "P", "");
    const update = vi.spyOn(commands, "updateNotePage");
    const notes: number[] = [];
    await backend().events.dataChanged.listen((e) => {
      if (e.payload.scopes.includes("notes")) notes.push(Date.now());
    });
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
    });
    for (const ch of "Bonjour Alice") {
      act(() => {
        editor.commands.insertContent(ch);
      });
      await wait(40);
    }
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await wait(700);
    expect(update).toHaveBeenCalledTimes(1);
    // The phone's backend diffs its rows once per `notes` event (Task 4): once here.
    expect(notes).toHaveLength(1);
  });

  it("opening then leaving a page without typing writes nothing", async () => {
    const s = await project();
    // Written by Claude, not the editor's way (« * », `_`), with an image of task 8.
    const a = await page(
      s,
      "A",
      "* un\n* deux\n\n_penché_ et ![[file:0192f0a1-7c2b-7d3e-9f00-112233445566|50%]]",
    );
    const b = await page(s, "B", "Texte.");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, a.id);
    act(() => {
      editor.commands.focus();
      editor.commands.blur();
    });
    // Another page, then away from the notebook.
    act(() => useUi.getState().openNotePage(s, b.id, false));
    await body();
    act(() => useUi.getState().setProjectTab("list"));
    await wait(700);
    expect(update).not.toHaveBeenCalled();
  });

  it("typing then undoing back to the stored text writes nothing", async () => {
    const s = await project();
    const p = await page(s, "P", "* un");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent("x");
    });
    act(() => {
      editor.commands.undo();
    });
    await wait(700);
    expect(update).not.toHaveBeenCalled();
  });

  it("leaving the page sends what is pending at once", async () => {
    const s = await project();
    const a = await page(s, "A", "Début");
    const b = await page(s, "B");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, a.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" et fin");
    });
    act(() => useUi.getState().openNotePage(s, b.id, false));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      id: a.id,
      title: null,
      body: "Début et fin",
    });
  });

  it("the app going to the background sends what is pending", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent("!");
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("a page longer than 256 Kio says so and is not sent; the text stays", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);
    const big = "a".repeat(MAX_NOTE_BODY_BYTES + 10);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(big);
    });
    expect(await screen.findByText(fr.notes.editor.tooLong)).toHaveAttribute(
      "role",
      "alert",
    );
    await wait(700);
    expect(update).not.toHaveBeenCalled();
    expect(editor.getMarkdown().length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    // Back under the limit: the message goes, the page is saved.
    act(() => {
      editor.commands.setContent("Court", {
        contentType: "markdown",
        emitUpdate: true,
      });
    });
    await waitFor(() =>
      expect(screen.queryByText(fr.notes.editor.tooLong)).toBeNull(),
    );
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("a change from another device shows when the page is not being written", async () => {
    const s = await project();
    const p = await page(s, "P", "Avant");
    const { el } = await openPage(s, p.id);
    await act(async () => {
      await backend().commands.updateNotePage({
        id: p.id,
        title: null,
        body: "Après, écrit par Claude",
      });
    });
    await waitFor(() =>
      expect(el).toHaveTextContent("Après, écrit par Claude"),
    );
  });
});

describe("no text is ever lost (fix round 1)", () => {
  /** Tiptap focuses on the next frame. */
  async function focus(editor: Editor) {
    await act(async () => {
      editor.commands.focus("end");
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it("a change from elsewhere shows even while the page has the focus, if nothing is typed", async () => {
    const s = await project();
    const p = await page(s, "P", "Avant");
    const update = vi.spyOn(commands, "updateNotePage");
    const { el, editor } = await openPage(s, p.id);
    await focus(editor);
    expect(editor.isFocused).toBe(true);
    await act(async () => {
      await backend().commands.updateNotePage({
        id: p.id,
        title: null,
        body: "Avant, et la suite écrite par Claude",
      });
    });
    await waitFor(() =>
      expect(el).toHaveTextContent("Avant, et la suite écrite par Claude"),
    );
    // The caret stayed where it was; typing now builds on that version.
    expect(editor.state.selection.from).toBe(6);
    update.mockClear();
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" !");
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0].body).toBe(
      "Avant, et la suite écrite par Claude !",
    );
  });

  it("while an edit is pending, the user's text wins (last writer wins)", async () => {
    const s = await project();
    const p = await page(s, "P", "Avant");
    const { editor } = await openPage(s, p.id);
    await focus(editor);
    act(() => {
      editor.commands.insertContent(" moi");
    });
    await act(async () => {
      await backend().commands.updateNotePage({
        id: p.id,
        title: null,
        body: "Autre appareil",
      });
    });
    await waitFor(async () =>
      expect((await backend().commands.getNotePage(p.id)).body).toBe(
        "Avant moi",
      ),
    );
  });

  it("too long: said in the toolbar, and the text survives leaving the page", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);
    const big = "a".repeat(MAX_NOTE_BODY_BYTES + 10);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(big);
    });
    const toolbar = screen.getByRole("toolbar", {
      name: fr.notes.editor.toolbar,
    });
    expect(
      await within(toolbar).findByText(fr.notes.editor.tooLong),
    ).toHaveAttribute("role", "alert");
    // Away and back: the draft is still there, never sent.
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await body();
    act(() => useUi.getState().openNotePage(s, p.id, false));
    const again = await body();
    await waitFor(() =>
      expect(again.editor.getMarkdown().length).toBeGreaterThan(
        MAX_NOTE_BODY_BYTES,
      ),
    );
    expect(screen.getAllByText(fr.notes.editor.tooLong).length).toBeGreaterThan(
      0,
    );
    await wait(700);
    expect(update).not.toHaveBeenCalled();
    // Shortened: saved, and the draft is gone.
    act(() => {
      again.editor.commands.setContent("Court", {
        contentType: "markdown",
        emitUpdate: true,
      });
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((await backend().commands.getNotePage(p.id)).body).toBe("Court");
  });

  it("a save that failed is sent again when the page closes", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    const update = vi
      .spyOn(commands, "updateNotePage")
      .mockRejectedValueOnce(new Error("disk full"));
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" fin");
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await wait(10);
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(async () =>
      expect((await backend().commands.getNotePage(p.id)).body).toBe(
        "Début fin",
      ),
    );
  });

  it("deleting a page sends its last characters first, without an error", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const update = vi.spyOn(commands, "updateNotePage");
    const del = vi.spyOn(commands, "deleteNotePage");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" fin");
    });
    await act(async () => {
      await deleteNotePage(p.id);
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      del.mock.invocationCallOrder[0] ?? 0,
    );
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      fr.notes.deleted,
    ]);
    // « Annuler » brings back the text with its last characters.
    await act(async () => {
      await backend().commands.restoreNotePage(p.id);
    });
    expect((await backend().commands.getNotePage(p.id)).body).toBe("Début fin");
  });

  it("« Dupliquer » copies the last characters typed", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" fin");
    });
    const items = pageMenuItems(
      s,
      { id: p.id, title: p.title, kind: "page", place: "ungrouped" },
      [],
      { x: 0, y: 0 },
    );
    const dup = items.find(
      (i): i is Extract<typeof i, { label: string }> =>
        "label" in i && i.label === fr.notes.duplicate,
    );
    await act(async () => {
      dup?.onSelect();
      await new Promise((r) => setTimeout(r, 50));
    });
    const nb = await backend().commands.notebook(s);
    const copy = nb.ungrouped.find((x) => x.title !== "P");
    expect(copy).toBeDefined();
    expect((await backend().commands.getNotePage(copy?.id ?? "")).body).toBe(
      "Début fin",
    );
  });
});

describe("too-long drafts (fix round 2)", () => {
  const big = () => "a".repeat(MAX_NOTE_BODY_BYTES + 10);

  /** Opens `p`, types past the limit, then opens `other`: the text is kept as a draft. */
  async function leaveADraft(s: string, p: string, other: string) {
    const { editor } = await openPage(s, p);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(big());
    });
    await waitFor(() => expect(noteDraft(p)).not.toBeNull());
    act(() => useUi.getState().openNotePage(s, other, false));
    await body();
  }

  it("a draft made before the page changed elsewhere is offered, never applied silently", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    const update = vi.spyOn(commands, "updateNotePage");
    await leaveADraft(s, p.id, other.id);
    // Meanwhile Claude (or another device) rewrites the page.
    await backend().commands.updateNotePage({
      id: p.id,
      title: null,
      body: "Réécrit par Claude",
    });
    update.mockClear();
    act(() => useUi.getState().openNotePage(s, p.id, false));
    const { el, editor } = await body();
    // The stored page shows, with the choice.
    await waitFor(() => expect(el).toHaveTextContent("Réécrit par Claude"));
    expect(screen.getByText(fr.notes.editor.draftConflict)).toBeInTheDocument();
    await wait(700);
    expect(update).not.toHaveBeenCalled();
    // « Garder la version actuelle »: the draft goes, nothing is written.
    await userEvent.click(
      screen.getByRole("button", { name: fr.notes.editor.draftKeepCurrent }),
    );
    expect(screen.queryByText(fr.notes.editor.draftConflict)).toBeNull();
    expect(noteDraft(p.id)).toBeNull();
    expect(editor.getMarkdown()).toBe("Réécrit par Claude");
    await wait(700);
    expect(update).not.toHaveBeenCalled();
  });

  it("« Reprendre mon brouillon » loads it, still subject to the limit", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    await leaveADraft(s, p.id, other.id);
    await backend().commands.updateNotePage({
      id: p.id,
      title: null,
      body: "Réécrit",
    });
    act(() => useUi.getState().openNotePage(s, p.id, false));
    const { editor } = await body();
    await userEvent.click(
      await screen.findByRole("button", { name: fr.notes.editor.draftResume }),
    );
    expect(editor.getMarkdown().length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(
      (await screen.findAllByText(fr.notes.editor.tooLong)).length,
    ).toBeGreaterThan(0);
    expect((await backend().commands.getNotePage(p.id)).body).toBe("Réécrit");
  });

  it("the draft stays until a save went through", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    await leaveADraft(s, p.id, other.id);
    const update = vi
      .spyOn(commands, "updateNotePage")
      .mockRejectedValueOnce(new Error("offline"));
    act(() => useUi.getState().openNotePage(s, p.id, false));
    const { editor } = await body();
    act(() => {
      editor.commands.setContent("Court", {
        contentType: "markdown",
        emitUpdate: true,
      });
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await wait(20);
    expect(noteDraft(p.id)).not.toBeNull();
    act(() => {
      editor.commands.insertContent("!");
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(noteDraft(p.id)).toBeNull());
  });

  it("« texte gardé » only when really leaving the page, not on React's double mount", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    await leaveADraft(s, p.id, other.id);
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
        fr.notes.editor.draftKept,
      ]),
    );
    cleanup();
    useToasts.setState({ toasts: [] });
    act(() => useUi.getState().openNotePage(s, p.id, false));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    const { editor } = await body();
    await wait(50);
    // The draft is back (written over the stored text), and no toast.
    expect(editor.getMarkdown().length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  /** Leaves a draft on `p`, then opens it again: the draft is back on screen. */
  async function reopenWithDraft(s: string, p: string, other: string) {
    await leaveADraft(s, p, other);
    useToasts.setState({ toasts: [] });
    act(() => useUi.getState().openNotePage(s, p, false));
    const opened = await body();
    await waitFor(() =>
      expect(opened.editor.getMarkdown().length).toBeGreaterThan(
        MAX_NOTE_BODY_BYTES,
      ),
    );
    return opened;
  }

  it("a refresh of the notebook keeps the editor with its draft (no remount, no toast)", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    const { el, editor } = await reopenWithDraft(s, p.id, other.id);
    // Reading a page takes a moment, as through the Mac's core.
    const read = commands.getNotePage;
    vi.spyOn(commands, "getNotePage").mockImplementation(
      (id) =>
        new Promise((resolve, reject) =>
          setTimeout(() => read(id).then(resolve, reject), 30),
        ),
    );
    // A `notes` data event: the page renamed, another page changed.
    await act(async () => {
      await backend().commands.updateNotePage({
        id: p.id,
        title: "Renommée",
        body: null,
      });
      await backend().commands.updateNotePage({
        id: other.id,
        title: null,
        body: "Autre texte",
      });
      // Data events reach the queries in batches, every 100 ms.
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(el.isConnected).toBe(true);
    expect(editor.isDestroyed).toBe(false);
    expect(screen.queryByText(fr.common.loading)).toBeNull();
    expect(editor.getMarkdown().length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("a newer version arriving while a restored draft is on screen offers the choice", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    const { el, editor } = await reopenWithDraft(s, p.id, other.id);
    await act(async () => {
      await backend().commands.updateNotePage({
        id: p.id,
        title: null,
        body: "Nouveau, écrit ailleurs",
      });
    });
    expect(
      await screen.findByText(fr.notes.editor.draftConflict),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(el).toHaveTextContent("Nouveau, écrit ailleurs"),
    );
    expect(editor.getMarkdown()).toBe("Nouveau, écrit ailleurs");
    // Still kept, over the text it was written on.
    expect(noteDraft(p.id)?.base).toBe("Début");
    expect((await backend().commands.getNotePage(p.id)).body).toBe(
      "Nouveau, écrit ailleurs",
    );
  });

  it("typing during the choice keeps the current version; « Annuler » brings the draft back", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const other = await page(s, "Autre");
    await leaveADraft(s, p.id, other.id);
    await backend().commands.updateNotePage({
      id: p.id,
      title: null,
      body: "Réécrit",
    });
    useToasts.setState({ toasts: [] });
    act(() => useUi.getState().openNotePage(s, p.id, false));
    const { editor } = await body();
    await screen.findByText(fr.notes.editor.draftConflict);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" !");
    });
    // An explicit choice: the banner goes, the draft too, with a way back.
    expect(screen.queryByText(fr.notes.editor.draftConflict)).toBeNull();
    expect(noteDraft(p.id)).toBeNull();
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.message === fr.notes.editor.draftDropped);
    expect(toast?.action?.label).toBe(fr.toast.undo);
    await waitFor(async () =>
      expect((await backend().commands.getNotePage(p.id)).body).toBe(
        "Réécrit !",
      ),
    );
    act(() => toast?.action?.onAction());
    expect(
      await screen.findByText(fr.notes.editor.draftConflict),
    ).toBeInTheDocument();
    expect(noteDraft(p.id)?.markdown.length).toBeGreaterThan(
      MAX_NOTE_BODY_BYTES,
    );
    await userEvent.click(
      screen.getByRole("button", { name: fr.notes.editor.draftResume }),
    );
    expect(editor.getMarkdown().length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
  });

  it("deleting a page with a draft: no save attempt, no « gardé » toast", async () => {
    const s = await project();
    const p = await page(s, "P", "Début");
    const update = vi.spyOn(commands, "updateNotePage");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(big());
    });
    await waitFor(() => expect(noteDraft(p.id)).not.toBeNull());
    await act(async () => {
      await deleteNotePage(p.id);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(update).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      fr.notes.deleted,
    ]);
  });
});

describe("formatting", () => {
  it("⌘B puts the selection in bold", async () => {
    const s = await project();
    const p = await page(s, "P", "Important");
    const { el, editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus();
      editor.commands.selectAll();
    });
    // jsdom is not a Mac: Mod is Ctrl there.
    fireEvent.keyDown(el, { key: "b", ctrlKey: true });
    expect(editor.getMarkdown()).toBe("**Important**");
  });

  it("the toolbar on top of the page formats and shows what is on", async () => {
    const s = await project();
    const p = await page(s, "P", "Important");
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus();
      editor.commands.selectAll();
    });
    const toolbar = screen.getByRole("toolbar", {
      name: fr.notes.editor.toolbar,
    });
    const highlight = within(toolbar).getByRole("button", {
      name: fr.notes.editor.highlight,
    });
    fireEvent.click(highlight);
    expect(editor.getMarkdown()).toBe("==Important==");
    expect(highlight).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(toolbar).getByRole("button", { name: fr.notes.editor.taskList }),
    );
    expect(editor.getMarkdown()).toBe("- [ ] ==Important==");
  });
});

describe("[[ links", () => {
  it("lists the project's pages then its tasks; Enter inserts the link", async () => {
    const s = await project();
    const here = await page(s, "Ici");
    const mails = await page(s, "Style des mails");
    await page(s, "Serveur");
    const t = await task(s, "Mails transactionnels");
    const update = vi.spyOn(commands, "updateNotePage");
    const { el, editor } = await openPage(s, here.id);

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent("Voir [[mail");
    });
    const list = await screen.findByRole("listbox", {
      name: fr.notes.editor.linkSuggest,
    });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Style des mails"),
      expect.stringContaining("Mails transactionnels"),
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(el, { key: "ArrowDown" });
    await waitFor(() =>
      expect(within(list).getAllByRole("option")[1]).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    fireEvent.keyDown(el, { key: "ArrowUp" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(editor.getMarkdown()).toBe(
      `Voir [[page:${mails.id}|Style des mails]] `,
    );
    await waitFor(() => expect(update).toHaveBeenCalled());
    // The page itself is never offered.
    act(() => {
      editor.commands.insertContent("[[Ici");
    });
    const again = await screen.findByRole("listbox", {
      name: fr.notes.editor.linkSuggest,
    });
    expect(within(again).queryAllByRole("option")).toHaveLength(0);
    expect(again).toHaveTextContent(fr.notes.editor.linkNone);
    void t;
  });

  it("a link shows as a chip with the current title; dead links are struck", async () => {
    const s = await project();
    const target = await page(s, "Nouveau titre");
    const t = await task(s, "Tâche liée");
    const gone = await page(s, "Partie");
    await backend().commands.deleteNotePage(gone.id);
    const p = await page(
      s,
      "P",
      `[[page:${target.id}|Ancien titre]] [[task:${t.id}|Vieux]] [[page:${gone.id}|Partie]]`,
    );
    await openPage(s, p.id);
    const chip = await screen.findByRole("button", {
      name: "Page : Nouveau titre",
    });
    expect(chip).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Tâche : Tâche liée" }),
    ).toBeInTheDocument();
    const dead = await screen.findByText(fr.notes.editor.linkDead("Partie"));
    expect(dead.closest("[data-wiki-link]")).toHaveClass("line-through");
    // A task renamed elsewhere: the chip follows.
    await act(async () => {
      await backend().commands.updateTask({
        id: t.id,
        title: "Renommée",
        description: null,
      });
    });
    expect(
      await screen.findByRole("button", { name: "Tâche : Renommée" }),
    ).toBeInTheDocument();
    // Deleted on another device: struck through, with the label kept in the Markdown.
    await act(async () => {
      await backend().commands.deleteTask(t.id);
    });
    expect(
      await screen.findByText(fr.notes.editor.linkDead("Vieux")),
    ).toBeInTheDocument();
  });

  it("clicking a page chip opens the page; a task chip opens its panel", async () => {
    const s = await project();
    const target = await page(s, "Cible", "Texte de la cible");
    const t = await task(s, "Tâche liée");
    const p = await page(
      s,
      "P",
      `[[page:${target.id}|Cible]] et [[task:${t.id}|Tâche liée]]`,
    );
    const { el } = await openPage(s, p.id);
    await userEvent.click(
      await within(el).findByRole("button", { name: "Tâche : Tâche liée" }),
    );
    expect(useUi.getState().openTaskId).toBe(t.id);
    await userEvent.click(
      await within(el).findByRole("button", { name: "Page : Cible" }),
    );
    await waitFor(() =>
      expect(useUi.getState().lastNotePage[s]).toBe(target.id),
    );
  });
});

describe("« Mentionné dans »", () => {
  it("lists the pages and the tasks that link the page", async () => {
    const s = await project();
    const p = await page(s, "Style des mails");
    const other = await page(s, "Décisions", `Voir [[page:${p.id}|Style]]`);
    const t = await task(
      s,
      "Mails transactionnels",
      `cf. [[page:${p.id}|Style]]`,
    );
    await openPage(s, p.id);
    const mentions = await screen.findByRole("region", {
      name: fr.notes.mentionedIn,
    });
    await within(mentions).findByRole("button", { name: /Décisions/ });
    await userEvent.click(
      within(mentions).getByRole("button", { name: /Mails transactionnels/ }),
    );
    expect(useUi.getState().openTaskId).toBe(t.id);
    void other;
  });

  it("the task panel lists the pages that mention the task", async () => {
    const s = await project();
    const t = await task(s, "Mails transactionnels");
    const p = await page(s, "Style des mails", `Fait dans [[task:${t.id}|M]]`);
    act(() => {
      useUi.getState().setView({ kind: "subject", subjectId: s });
      useUi.getState().openTask(t.id);
    });
    render(<App />);
    const fold = await screen.findByRole("region", {
      name: fr.notes.mentionedInNotes,
    });
    await userEvent.click(
      within(fold).getByRole("button", { name: /Style des mails/ }),
    );
    await waitFor(() => {
      expect(useUi.getState().projectTab).toBe("notes");
      expect(useUi.getState().lastNotePage[s]).toBe(p.id);
    });
  });
});
