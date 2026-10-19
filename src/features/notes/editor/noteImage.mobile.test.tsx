// Images in a page on the phone: the photo picker
// (camera included), shown from the phone's files, sizes by touch at 44 px, no corner handle,
// and a tap on an image never raises the keyboard.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fr } from "../../../i18n/fr";
import type { Phone } from "../../../mobile/test/helpers";

vi.mock("../../../lib/target", () => ({ IS_MOBILE: true }));

let phone: Phone;
let MobileApp: typeof import("../../../mobile/MobileApp").default;
let ui: typeof import("../../../stores/ui");

beforeAll(async () => {
  const helpers = await import("../../../mobile/test/helpers");
  phone = helpers.makePhone();
  globalThis.__TODO_BACKEND__ = phone.backend;
  MobileApp = (await import("../../../mobile/MobileApp")).default;
  ui = await import("../../../stores/ui");
});

beforeEach(() => {
  phone.backend.reset({ seed: false });
  ui.resetUi();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:photo");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

async function openPage(
  body: string,
  /** Writes the page's text once it exists (its images need its id). */
  prepare?: (pageId: string) => Promise<void>,
) {
  const c = phone.backend.commands;
  const s = await c.createSubject({
    name: "Taido",
    color: null,
    rootPath: null,
    parentId: null,
  });
  const p = await c.createNotePage({
    subjectId: s.id,
    groupId: null,
    title: "Chantier",
    body,
    kind: "page",
    sourceTaskId: null,
  });
  await prepare?.(p.id);
  act(() => {
    ui.useUi.getState().setView({ kind: "subject", subjectId: s.id });
    ui.useUi.getState().toggleSidebar(false);
    ui.useUi.getState().setProjectTab("notes");
    ui.useUi.getState().openNotePage(s.id, p.id, true);
  });
  render(<MobileApp backend={phone.backend} />);
  const sheet = await screen.findByRole("dialog", { name: "Chantier" });
  const el = within(sheet).getByRole("textbox", {
    name: fr.notes.editor.bodyLabel,
  });
  const editor = (el as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error("no editor");
  return { sheet, editor, page: p };
}

describe("images on the phone", () => {
  it("a photo picked (camera included) is kept on the phone, shown, and sized by touch", async () => {
    const { sheet, editor, page } = await openPage("Le mur nord.");
    const input = sheet.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toBe("image/*");
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(["jpeg"], "IMG_1.jpg", { type: "image/jpeg" })],
      },
    });
    const [added] = await waitFor(async () => {
      const list = await phone.backend.commands.listNoteAttachments(page.id);
      expect(list).toHaveLength(1);
      return list;
    });
    await waitFor(() =>
      expect(editor.getMarkdown()).toBe(
        `Le mur nord.\n\n![[file:${added.id}|100%]]`,
      ),
    );
    // Offline or not, it shows at once from the phone's own copy.
    await waitFor(() =>
      expect(
        sheet.querySelector("[data-note-image] img")?.getAttribute("src"),
      ).toBe("blob:photo"),
    );
    // No corner handle under a finger: a tap shows the sizes, 44 px each.
    expect(
      within(sheet).queryByRole("button", { name: fr.notes.image.resize }),
    ).toBeNull();
    fireEvent.click(
      within(sheet).getByRole("button", {
        name: fr.notes.image.label("IMG_1.jpg", 100),
      }),
    );
    expect(editor.isFocused).toBe(false);
    const sizes = within(sheet).getByRole("toolbar", {
      name: fr.notes.image.sizes,
    });
    for (const b of within(sizes).getAllByRole("button")) {
      expect(b).toHaveClass("h-11", "min-w-11");
    }
    fireEvent.click(within(sizes).getByRole("button", { name: "75 %" }));
    expect(editor.getMarkdown()).toBe(
      `Le mur nord.\n\n![[file:${added.id}|75%]]`,
    );
  });

  it("a picked file that is not an image is refused", async () => {
    const { sheet, page } = await openPage("");
    const input = sheet.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(["%PDF"], "devis.pdf", { type: "application/pdf" })],
      },
    });
    await screen.findByText(fr.notes.image.onlyImages);
    expect(await phone.backend.commands.listNoteAttachments(page.id)).toEqual(
      [],
    );
  });

  it("« Retirer » takes the image out with a toast whose « Annuler » puts it back", async () => {
    const c = phone.backend.commands;
    let body = "";
    const { sheet, editor } = await openPage("", async (pageId) => {
      const a = await c.addNoteAttachmentData({
        notePageId: pageId,
        name: "IMG_2.jpg",
        base64: "iVBORw0KGgo=",
      });
      body = `Avant.\n\n![[file:${a.id}|50%]]`;
      await c.updateNotePage({ id: pageId, title: null, body });
    });
    fireEvent.click(
      await within(sheet).findByRole("button", {
        name: fr.notes.image.label("IMG_2.jpg", 50),
      }),
    );
    fireEvent.click(
      within(sheet).getByRole("button", { name: fr.notes.image.remove }),
    );
    expect(editor.getMarkdown()).toBe("Avant.");
    expect(await screen.findByText(fr.notes.image.removed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: fr.toast.undo }));
    expect(editor.getMarkdown()).toBe(body);
  });

  it("the sizes bar of an image on the right stays inside the text column", async () => {
    const c = phone.backend.commands;
    const { sheet } = await openPage("", async (pageId) => {
      const a = await c.addNoteAttachmentData({
        notePageId: pageId,
        name: "IMG_3.jpg",
        base64: "iVBORw0KGgo=",
      });
      await c.updateNotePage({
        id: pageId,
        title: null,
        body: `![[file:${a.id}|25%]]`,
      });
    });
    const box = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 40,
        height: 40,
      }) as DOMRect;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("ProseMirror")) return box(16, 358);
      if (this.hasAttribute("data-note-image")) return box(300, 74);
      if (this.classList.contains("note-image-sizes")) return box(300, 300);
      return rect.call(this);
    };
    try {
      fireEvent.click(
        await within(sheet).findByRole("button", {
          name: fr.notes.image.label("IMG_3.jpg", 25),
        }),
      );
      const sizes = within(sheet).getByRole("toolbar", {
        name: fr.notes.image.sizes,
      });
      // 300 + 300 = 600 past the column's right edge (374): moved 226 px to the left.
      expect(sizes.style.left).toBe("-226px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });
});
