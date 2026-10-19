/**
 * Images in a page on the Mac: pasted, dropped
 * (the Finder's drop goes to the open page, not to a task) or picked; resized live with the
 * corner handle, rounded to 5 %; sizes and « Supprimer » on a click; a missing file shows a
 * grey frame; a page only takes images.
 */

import type { DragDropEvent } from "@tauri-apps/api/webview";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../App";
import { useToasts } from "../../../components/Toast";
import { fr } from "../../../i18n/fr";
import { commands, mockBackend } from "../../../lib/ipc";
import { guardStrayDrops } from "../../../lib/web-files";
import { resetUi, useUi } from "../../../stores/ui";
import { handleDragDrop } from "../../terminals/fileDrop";
import { forgetDeletedHere } from "../noteActions";
import { forgetImageClipboard } from "./imageClipboard";
import { forgetNoteDrafts, keepNoteDraft } from "./pendingEdits";

const PNG = "iVBORw0KGgo=";
const UNKNOWN = "0192f0a1-7c2b-7d3e-9f00-0123456789ab";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function project() {
  const s = await backend().commands.createSubject({
    name: "Taido",
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

function image(pageId: string, name = "capture.png") {
  return backend().commands.addNoteAttachmentData({
    notePageId: pageId,
    name,
    base64: PNG,
  });
}

async function openPage(subjectId: string, pageId: string) {
  act(() => {
    useUi.getState().setView({ kind: "subject", subjectId });
    useUi.getState().setProjectTab("notes");
    useUi.getState().openNotePage(subjectId, pageId, false);
  });
  const view = render(<App />);
  const el = await screen.findByRole("textbox", {
    name: fr.notes.editor.bodyLabel,
  });
  const editor = (el as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error("no editor on the page's text");
  return { el, editor, view };
}

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** The image's frame in the page. */
const frame = () =>
  document.querySelector<HTMLElement>("[data-note-image]") as HTMLElement;

beforeEach(() => {
  backend().reset({ seed: false });
  forgetNoteDrafts();
  forgetDeletedHere();
  forgetImageClipboard();
  resetUi();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adding an image", () => {
  it("a pasted image is added to the page and written ![[file:<id>|100%]]", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Écran d'accueil.");
    const add = vi.spyOn(commands, "addNoteAttachmentData");
    const update = vi.spyOn(commands, "updateNotePage");
    const { el, editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.focus("end");
    });
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File(["png"], "image.png", { type: "image/png" })],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][0]).toMatchObject({ notePageId: p.id });
    const [added] = await commands.listNoteAttachments(p.id);
    await waitFor(() =>
      expect(editor.getMarkdown()).toBe(
        `Écran d'accueil.\n\n![[file:${added.id}|100%]]`,
      ),
    );
    // Shown at once, from the file's preview.
    await waitFor(() =>
      expect(frame().querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      ),
    );
    expect(frame().style.width).toBe("100%");
    await wait(700);
    expect(update).toHaveBeenLastCalledWith({
      id: p.id,
      title: null,
      body: `Écran d'accueil.\n\n![[file:${added.id}|100%]]`,
    });
  });

  it("a file that is not an image is refused: « Seules les images vont dans une page »", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    const add = vi.spyOn(commands, "addNoteAttachmentData");
    const { el, editor } = await openPage(s, p.id);
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File(["%PDF"], "devis.pdf", { type: "application/pdf" })],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
        fr.notes.image.onlyImages,
      ),
    );
    expect(add).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe("Texte.");
  });

  it("pasted text that comes with a picture of it (Word, Excel) stays text", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const add = vi.spyOn(commands, "addNoteAttachmentData");
    const { el } = await openPage(s, p.id);
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File(["png"], "image.png", { type: "image/png" })],
        types: ["text/plain", "Files"],
        getData: (type: string) => (type === "text/plain" ? "Cellule A1" : ""),
      },
    });
    await wait(50);
    expect(add).not.toHaveBeenCalled();
  });

  it("a file dropped from the Finder on the open page goes to the page, not to a task", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    const toPage = vi.spyOn(commands, "addNoteAttachments");
    const toTask = vi.spyOn(commands, "addAttachments");
    const { el, editor } = await openPage(s, p.id);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => el,
    });
    act(() =>
      handleDragDrop({
        type: "drop",
        paths: ["/Users/user/Bureau/maquette.png", "/Users/user/devis.pdf"],
        position: { x: 10, y: 10 },
      } as unknown as DragDropEvent),
    );
    await waitFor(() => expect(toPage).toHaveBeenCalledTimes(1));
    expect(toPage).toHaveBeenCalledWith({
      notePageId: p.id,
      paths: ["/Users/user/Bureau/maquette.png"],
    });
    expect(toTask).not.toHaveBeenCalled();
    const [added] = await commands.listNoteAttachments(p.id);
    await waitFor(() =>
      expect(editor.getMarkdown()).toContain(`![[file:${added.id}|100%]]`),
    );
    // The PDF did not go anywhere, and the user is told why.
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
      fr.notes.image.onlyImages,
    );
  });

  it("the toolbar's image button picks files and adds the images", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    vi.spyOn(commands, "pickFiles").mockResolvedValue(["/tmp/schema.png"]);
    const { editor } = await openPage(s, p.id);
    fireEvent.click(screen.getByRole("button", { name: fr.notes.image.add }));
    const [added] = await waitFor(async () => {
      const list = await commands.listNoteAttachments(p.id);
      expect(list).toHaveLength(1);
      return list;
    });
    await waitFor(() =>
      expect(editor.getMarkdown()).toBe(`Texte.\n\n![[file:${added.id}|100%]]`),
    );
  });
});

describe("resizing", () => {
  it("the corner handle resizes live, rounded to 5 %, and writes the width once let go", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Intro.\n\n![[file:${a.id}|50%]]`,
    });
    const { editor } = await openPage(s, p.id);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.matches("[data-note-image]")
          ? 400
          : this.tagName === "P"
            ? 800
            : 0;
        return {
          width,
          height: 100,
          top: 0,
          left: 0,
          right: width,
          bottom: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    const handle = await screen.findByRole("button", {
      name: fr.notes.image.resize,
    });
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    // Live: the frame follows, the page is not written while dragging.
    expect(frame().style.width).toBe("25%");
    expect(editor.getMarkdown()).toContain(`|50%]]`);
    fireEvent.pointerMove(handle, { clientX: 310, pointerId: 1 });
    expect(frame().style.width).toBe("25%");
    fireEvent.pointerUp(handle, { clientX: 310, pointerId: 1 });
    expect(editor.getMarkdown()).toBe(`Intro.\n\n![[file:${a.id}|25%]]`);
  });

  it("a click shows « 25 % · 50 % · 75 % · 100 % · Supprimer »; a size applies at once", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `![[file:${a.id}]]`,
    });
    const { editor } = await openPage(s, p.id);
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 100),
      }),
    );
    const sizes = screen.getByRole("toolbar", { name: fr.notes.image.sizes });
    expect(
      Array.from(sizes.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["25 %", "50 %", "75 %", "100 %", fr.notes.image.remove]);
    expect(
      screen
        .getByRole("button", { name: "100 %" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "50 %" }));
    expect(editor.getMarkdown()).toBe(`![[file:${a.id}|50%]]`);
    await waitFor(() => expect(frame().style.width).toBe("50%"));
    expect(
      screen.getByRole("button", { name: "50 %" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("deleting", () => {
  it("« Supprimer » takes the image out; the core cleans its file up when the page closes", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const other = await page(s, "Autre", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Avant.\n\n![[file:${a.id}|50%]]`,
    });
    const prune = vi.spyOn(commands, "pruneNoteImages");
    const { editor } = await openPage(s, p.id);
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 50),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: fr.notes.image.remove }),
    );
    expect(editor.getMarkdown()).toBe("Avant.");
    // Still undoable while the page is open: the file stays.
    await wait(700);
    expect(prune).not.toHaveBeenCalled();
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await waitFor(() =>
      expect(prune).toHaveBeenCalledWith({
        pageId: p.id,
        candidateIds: [a.id],
      }),
    );
    await waitFor(async () =>
      expect(await commands.listNoteAttachments(p.id)).toEqual([]),
    );
  });

  it("an image taken out then brought back with Annuler keeps its file", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const other = await page(s, "Autre", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Avant.\n\n![[file:${a.id}|50%]]`,
    });
    const prune = vi.spyOn(commands, "pruneNoteImages");
    const { editor } = await openPage(s, p.id);
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 50),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: fr.notes.image.remove }),
    );
    await wait(700);
    act(() => {
      editor.commands.undo();
    });
    expect(editor.getMarkdown()).toBe(`Avant.\n\n![[file:${a.id}|50%]]`);
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await wait(50);
    expect(prune).not.toHaveBeenCalled();
    expect((await commands.listNoteAttachments(p.id)).map((x) => x.id)).toEqual(
      [a.id],
    );
  });

  it("the removal's Annuler puts the image back at its place, whatever was typed since", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Avant.\n\n![[file:${a.id}|50%]]\n\nAprès.`,
    });
    const { editor } = await openPage(s, p.id);
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 50),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: fr.notes.image.remove }),
    );
    expect(editor.getMarkdown()).toBe("Avant.\n\nAprès.");
    // Typed since, before the place and at the end of the page.
    act(() => {
      editor.commands.insertContentAt(1, "Début ");
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        " Fin",
      );
    });
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.message === fr.notes.image.removed);
    expect(toast?.action).toBeDefined();
    act(() => toast?.action?.onAction());
    expect(editor.getMarkdown()).toBe(
      `Début Avant.\n\n![[file:${a.id}|50%]]\n\nAprès. Fin`,
    );
  });

  it("the removal's Annuler puts the image at the end when its place is gone", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Avant ![[file:${a.id}|50%]] après.`,
    });
    const { editor } = await openPage(s, p.id);
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 50),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: fr.notes.image.remove }),
    );
    // Everything replaced since: the place no longer exists.
    act(() => {
      editor.commands.setContent("Autre texte.", {
        contentType: "markdown",
        emitUpdate: true,
      });
    });
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.message === fr.notes.image.removed);
    act(() => toast?.action?.onAction());
    expect(editor.getMarkdown()).toContain(`![[file:${a.id}|50%]]`);
    expect(editor.getMarkdown()).toContain("Autre texte.");
  });

  it("an image of another page named in this one is never deleted from here", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const other = await page(s, "Autre", "");
    const theirs = await image(other.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Avant.\n\n![[file:${theirs.id}|50%]]`,
    });
    const { editor } = await openPage(s, p.id);
    act(() => {
      editor.commands.setContent("Avant.", {
        contentType: "markdown",
        emitUpdate: true,
      });
    });
    await wait(700);
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await wait(50);
    expect(
      (await commands.listNoteAttachments(other.id)).map((x) => x.id),
    ).toEqual([theirs.id]);
  });

  it("cut from page A, pasted in page B: B gets its own copy, A's close keeps the file", async () => {
    const s = await project();
    const a = await page(s, "A", "");
    const b = await page(s, "B", "Texte de B.");
    const x = await image(a.id);
    await commands.updateNotePage({
      id: a.id,
      title: null,
      body: `Avant.\n\n![[file:${x.id}|50%]]`,
    });
    const copy = vi.spyOn(commands, "copyNoteAttachment");
    const prune = vi.spyOn(commands, "pruneNoteImages");
    const { el, editor } = await openPage(s, a.id);
    await screen.findByRole("button", {
      name: fr.notes.image.label("capture.png", 50),
    });
    // Select the image and cut it.
    const clip = new Map<string, string>();
    const clipboardData = {
      setData: (t: string, v: string) => clip.set(t, v),
      getData: (t: string) => clip.get(t) ?? "",
      clearData: () => clip.clear(),
      get types() {
        return [...clip.keys()];
      },
      files: [] as File[],
    };
    act(() => {
      let pos = -1;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === "noteImage") pos = p;
      });
      editor.commands.setNodeSelection(pos);
    });
    fireEvent.cut(el, { clipboardData });
    expect(editor.getMarkdown()).not.toContain(x.id);
    expect(clip.get("text/html")).toContain(x.id);
    // A closes (B opens): the clipboard still holds the image, nothing is cleaned up.
    act(() => useUi.getState().openNotePage(s, b.id, false));
    await wait(700);
    expect(prune).not.toHaveBeenCalledWith(
      expect.objectContaining({ pageId: a.id, candidateIds: [x.id] }),
    );
    const bEl = await screen.findByRole("textbox", {
      name: fr.notes.editor.bodyLabel,
    });
    const bEditor = (bEl as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(bEditor.getMarkdown()).toBe("Texte de B."));
    act(() => {
      bEditor.commands.focus("end");
    });
    fireEvent.paste(bEl, { clipboardData });
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith({ id: x.id, toPageId: b.id }),
    );
    const [own] = await commands.listNoteAttachments(b.id);
    await waitFor(() =>
      expect(bEditor.getMarkdown()).toContain(`file:${own.id}`),
    );
    expect(bEditor.getMarkdown()).not.toContain(x.id);
    // A's file is still there for a second paste; its cleanup waits for the next copy.
    expect((await commands.listNoteAttachments(a.id)).map((i) => i.id)).toEqual(
      [x.id],
    );
    // Undo in B takes the pasted image out again (the copy is not in the history).
    await wait(700);
    expect((await commands.getNotePage(b.id)).body).toContain(`file:${own.id}`);
  });

  it("an image a dropped too-long draft still shows keeps its file (its « Annuler » brings it back)", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const other = await page(s, "Autre", "");
    const x = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `Début.\n\n![[file:${x.id}|50%]]`,
    });
    // A too-long draft written over an older text, that shows the image too.
    keepNoteDraft(p.id, {
      markdown: `Début et la suite.\n\n![[file:${x.id}|50%]]`,
      base: "Une version plus ancienne.",
    });
    const prune = vi.spyOn(commands, "pruneNoteImages");
    const { editor } = await openPage(s, p.id);
    await screen.findByText(fr.notes.editor.draftConflict);
    // Taking the image out of the current text drops the draft (with « Annuler »).
    fireEvent.click(
      await screen.findByRole("button", {
        name: fr.notes.image.label("capture.png", 50),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: fr.notes.image.remove }),
    );
    expect(editor.getMarkdown()).toBe("Début.");
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
        fr.notes.editor.draftDropped,
      ),
    );
    await wait(700);
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await wait(50);
    expect(prune).not.toHaveBeenCalledWith(
      expect.objectContaining({ candidateIds: [x.id] }),
    );
    expect((await commands.listNoteAttachments(p.id)).map((i) => i.id)).toEqual(
      [x.id],
    );
  });

  it("cut in A, away and back, pasted in A, then a copy within 600 ms: the image keeps its file", async () => {
    const s = await project();
    const a = await page(s, "A", "");
    const b = await page(s, "B", "Texte de B.");
    const x = await image(a.id);
    await commands.updateNotePage({
      id: a.id,
      title: null,
      body: `Avant.\n\n![[file:${x.id}|50%]]`,
    });
    const clip = new Map<string, string>();
    const clipboardData = {
      setData: (t: string, v: string) => clip.set(t, v),
      getData: (t: string) => clip.get(t) ?? "",
      clearData: () => clip.clear(),
      get types() {
        return [...clip.keys()];
      },
      files: [] as File[],
    };
    const textbox = async () => {
      const el = await screen.findByRole("textbox", {
        name: fr.notes.editor.bodyLabel,
      });
      return { el, editor: (el as HTMLElement & { editor: Editor }).editor };
    };
    const { el, editor } = await openPage(s, a.id);
    await screen.findByRole("button", {
      name: fr.notes.image.label("capture.png", 50),
    });
    act(() => {
      let pos = -1;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === "noteImage") pos = p;
      });
      editor.commands.setNodeSelection(pos);
    });
    fireEvent.cut(el, { clipboardData });
    // To B and back to A: A closed with the image cut out (kept for the clipboard).
    act(() => useUi.getState().openNotePage(s, b.id, false));
    await textbox();
    await wait(50);
    act(() => useUi.getState().openNotePage(s, a.id, false));
    await waitFor(async () => {
      const md = (await textbox()).editor.getMarkdown();
      expect(md).toContain("Avant.");
      expect(md).not.toContain(x.id);
    });
    const again = await textbox();
    act(() => {
      again.editor.commands.focus("end");
    });
    fireEvent.paste(again.el, { clipboardData });
    await waitFor(() =>
      expect(again.editor.getMarkdown()).toContain(`file:${x.id}`),
    );
    // A copy of some text, before the 600 ms save: the clipboard lets the image go…
    act(() => {
      again.editor.commands.setTextSelection({ from: 1, to: 4 });
    });
    fireEvent.copy(again.el, { clipboardData });
    // …but the page shows it again: its file stays.
    await wait(900);
    expect((await commands.listNoteAttachments(a.id)).map((i) => i.id)).toEqual(
      [x.id],
    );
    expect((await commands.getNotePage(a.id)).body).toContain(`file:${x.id}`);
  });

  it("the same image of another page pasted twice: each paste is this page's own copy", async () => {
    const s = await project();
    const a = await page(s, "A", "");
    const b = await page(s, "B", "Texte de B.");
    const x = await image(a.id);
    const copy = vi.spyOn(commands, "copyNoteAttachment");
    const { el, editor } = await openPage(s, b.id);
    const html = `<p><span data-note-image="" data-id="${x.id}" data-width="50"></span></p>`;
    const clipboardData = {
      getData: (t: string) => (t === "text/html" ? html : ""),
      types: ["text/html"],
      files: [] as File[],
    };
    act(() => {
      editor.commands.focus("end");
    });
    fireEvent.paste(el, { clipboardData });
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(editor.getMarkdown()).not.toContain(x.id));
    act(() => {
      editor.commands.focus("end");
    });
    fireEvent.paste(el, { clipboardData });
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editor.getMarkdown()).not.toContain(x.id));
    const own = (await commands.listNoteAttachments(b.id)).map((i) => i.id);
    expect(own).toHaveLength(2);
    for (const id of own) expect(editor.getMarkdown()).toContain(`file:${id}`);
  });

  it("an upload that ends after the page closed leaves no file behind", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    const other = await page(s, "Autre", "");
    const real = commands.addNoteAttachmentData;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(commands, "addNoteAttachmentData").mockImplementation(
      async (input) => {
        await gate;
        return real(input);
      },
    );
    const prune = vi.spyOn(commands, "pruneNoteImages");
    const { el } = await openPage(s, p.id);
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File(["png"], "image.png", { type: "image/png" })],
        types: ["Files"],
        getData: () => "",
      },
    });
    act(() => useUi.getState().openNotePage(s, other.id, false));
    await wait(20);
    release();
    await waitFor(() => expect(prune).toHaveBeenCalled());
    await waitFor(async () =>
      expect(await commands.listNoteAttachments(p.id)).toEqual([]),
    );
  });
});

describe("dropping from the browser (the site, the phone)", () => {
  it("a file dropped on the page lands, even with the stray-drop guard on", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    const stop = guardStrayDrops(window);
    try {
      const { el, editor } = await openPage(s, p.id);
      const file = new File(["png"], "photo.png", { type: "image/png" });
      const dataTransfer = {
        types: ["Files"],
        files: [file],
        dropEffect: "none",
        getData: () => "",
      };
      fireEvent.dragOver(el, { dataTransfer });
      expect(dataTransfer.dropEffect).not.toBe("none");
      fireEvent.drop(el, { dataTransfer });
      const [added] = await waitFor(async () => {
        const list = await commands.listNoteAttachments(p.id);
        expect(list).toHaveLength(1);
        return list;
      });
      await waitFor(() =>
        expect(editor.getMarkdown()).toBe(
          `Texte.\n\n![[file:${added.id}|100%]]`,
        ),
      );
    } finally {
      stop();
    }
  });
});

describe("what an image shows", () => {
  it("an id unknown here, nothing left to sync: « Image introuvable », at its width", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", `![[file:${UNKNOWN}|40%]]`);
    const { editor } = await openPage(s, p.id);
    await screen.findByText(fr.notes.image.missing);
    expect(screen.queryByText(fr.notes.image.downloading)).toBeNull();
    expect(frame().style.width).toBe("40%");
    expect(editor.getMarkdown()).toBe(`![[file:${UNKNOWN}|40%]]`);
  });

  it("an id unknown here while the sync runs: « Image en cours de téléchargement »", async () => {
    const real = await commands.syncStatus();
    vi.spyOn(commands, "syncStatus").mockResolvedValue({
      ...real,
      state: "syncing",
    });
    const s = await project();
    const p = await page(s, "Maquettes", `![[file:${UNKNOWN}|40%]]`);
    await openPage(s, p.id);
    await screen.findByText(fr.notes.image.downloading);
  });

  it("an image of another page is shown by its id", async () => {
    const s = await project();
    const other = await page(s, "Autre", "");
    const theirs = await image(other.id);
    const p = await page(s, "Maquettes", `![[file:${theirs.id}|50%]]`);
    await openPage(s, p.id);
    await waitFor(() =>
      expect(frame().querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      ),
    );
  });

  it("an image of another page with no preview (HEIC): its name and « Ouvrir »", async () => {
    const s = await project();
    const other = await page(s, "Autre", "");
    const [theirs] = await commands.addNoteAttachments({
      notePageId: other.id,
      paths: ["/tmp/IMG_0042.HEIC"],
    });
    const p = await page(s, "Maquettes", `![[file:${theirs.id}|50%]]`);
    await openPage(s, p.id);
    await screen.findByText("IMG_0042.HEIC");
    expect(screen.queryByText(fr.notes.image.missing)).toBeNull();
    expect(
      screen.getByRole("button", { name: fr.notes.image.open }),
    ).toBeInTheDocument();
  });

  it("an image of another page that arrives later shows once it is here", async () => {
    const s = await project();
    const other = await page(s, "Autre", "");
    const theirs = await image(other.id);
    // Not on this device yet (to download).
    backend().links.setRemote(theirs.id, "to_download");
    const p = await page(s, "Maquettes", `![[file:${theirs.id}|50%]]`);
    await openPage(s, p.id);
    await screen.findByText(fr.notes.image.downloading);
    // The file arrives: the notebook hears it, the image shows.
    act(() => {
      backend().links.setRemote(theirs.id, "none");
      backend().emitDataChanged(["notes"]);
    });
    await waitFor(() =>
      expect(frame().querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      ),
    );
  });

  it("while the page's images are read: a plain frame, no « téléchargement » flash", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id);
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `![[file:${a.id}|50%]]`,
    });
    const real = commands.listNoteAttachments;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(commands, "listNoteAttachments").mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    await openPage(s, p.id);
    await waitFor(() =>
      expect(frame().querySelector("[aria-busy=true]")).not.toBeNull(),
    );
    expect(screen.queryByText(fr.notes.image.downloading)).toBeNull();
    expect(screen.queryByText(fr.notes.image.missing)).toBeNull();
    release();
    await waitFor(() => expect(frame().querySelector("img")).not.toBeNull());
  });

  it("a preview that fails shows the file (name and « Ouvrir »)", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const a = await image(p.id, "plan.png");
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `![[file:${a.id}]]`,
    });
    vi.spyOn(commands, "attachmentPreview").mockRejectedValue({
      kind: "internal",
      message: "io",
    });
    await openPage(s, p.id);
    await screen.findByText("plan.png");
    expect(
      screen.getByRole("button", { name: fr.notes.image.open }),
    ).toBeInTheDocument();
    expect(screen.queryByText(fr.notes.image.downloading)).toBeNull();
  });

  it("an image format a page does not take: « Format d'image non pris en charge »", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "Texte.");
    const add = vi.spyOn(commands, "addNoteAttachmentData");
    const { el } = await openPage(s, p.id);
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File(["ico"], "favicon.ico", { type: "image/x-icon" })],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
        fr.notes.image.unsupportedFormat,
      ),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("an image with no preview (HEIC, too large): its name and « Ouvrir »", async () => {
    const s = await project();
    const p = await page(s, "Maquettes", "");
    const [a] = await commands.addNoteAttachments({
      notePageId: p.id,
      paths: ["/tmp/IMG_0042.HEIC"],
    });
    await commands.updateNotePage({
      id: p.id,
      title: null,
      body: `![[file:${a.id}]]`,
    });
    const open = vi.spyOn(commands, "openPath").mockResolvedValue(null);
    await openPage(s, p.id);
    await screen.findByText("IMG_0042.HEIC");
    fireEvent.click(screen.getByRole("button", { name: fr.notes.image.open }));
    expect(open).toHaveBeenCalledWith({
      path: a.path,
      with: null,
      editor: null,
    });
  });
});
