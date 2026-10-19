/**
 * Pages are Markdown: what the editor reads it must write
 * back the same, so opening a page never rewrites it (§ 5.1).
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { noteExtensions } from "./extensions";
import {
  FILE_ID,
  IMAGE_FIXTURES,
  MARKDOWN_FIXTURES,
  NORMALISED,
  PAGE_ID,
  PRESERVED,
  TASK_ID,
} from "./markdown.fixtures";
import { imageIdsIn, parseWidth, snapWidth, widthAfterDrag } from "./noteImage";

let editor: Editor | null = null;

function load(md: string): Editor {
  editor?.destroy();
  editor = new Editor({
    extensions: noteExtensions(),
    content: md,
    contentType: "markdown",
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Markdown round trip", () => {
  for (const [name, md] of Object.entries(MARKDOWN_FIXTURES)) {
    it(`${name} comes back unchanged`, () => {
      expect(load(md).getMarkdown()).toBe(md);
    });
  }

  it("setContent with contentType markdown gives the same text back", () => {
    const ed = load("");
    for (const md of Object.values(MARKDOWN_FIXTURES)) {
      ed.commands.setContent(md, { contentType: "markdown" });
      expect(ed.getMarkdown()).toBe(md);
    }
  });

  for (const [input, output] of NORMALISED) {
    it(`${JSON.stringify(input)} reads the same and writes the editor's way`, () => {
      expect(load(input).getMarkdown()).toBe(output);
      expect(load(output).getMarkdown()).toBe(output);
    });
  }
});

describe("Markdown the editor does not edit survives a change elsewhere", () => {
  for (const [name, md] of Object.entries(PRESERVED)) {
    it(`${name}`, () => {
      const ed = load(`Intro.\n\n${md}`);
      expect(ed.getMarkdown()).toBe(`Intro.\n\n${md}`);
      ed.commands.insertContentAt(1, "Nouvelle ");
      expect(ed.getMarkdown()).toBe(`Nouvelle Intro.\n\n${md}`);
    });
  }
});

describe("what the editor makes of the Markdown", () => {
  it("[[page:…]] and [[task:…]] are links with their kind, id and label", () => {
    const ed = load(
      `${MARKDOWN_FIXTURES.pageLink}\n\n${MARKDOWN_FIXTURES.taskLink}`,
    );
    const links: unknown[] = [];
    ed.state.doc.descendants((n) => {
      if (n.type.name === "wikiLink") links.push(n.attrs);
    });
    expect(links).toEqual([
      { kind: "page", id: PAGE_ID, label: "Style des mails" },
      { kind: "task", id: TASK_ID, label: "Mails transactionnels" },
    ]);
  });

  it("![[file:<id>|<l>%]] is an image of the page, with its width", () => {
    const md = `Capture :\n\n![[file:${FILE_ID}|50%]]\n\nEt ![[file:${PAGE_ID}]] dans le texte, ![[file:${TASK_ID}|300]].`;
    const ed = load(md);
    expect(ed.getMarkdown()).toBe(md);
    const images: unknown[] = [];
    ed.state.doc.descendants((n) => {
      if (n.type.name === "noteImage") images.push([n.attrs.id, n.attrs.width]);
      expect(n.type.name).not.toBe("rawInline");
    });
    expect(images).toEqual([
      [FILE_ID, 50],
      [PAGE_ID, null],
      [TASK_ID, null],
    ]);
  });

  it("every image form survives a change elsewhere in the page", () => {
    for (const md of Object.values(IMAGE_FIXTURES)) {
      const ed = load(`Intro.\n\n${md}`);
      ed.commands.insertContentAt(1, "Nouvelle ");
      expect(ed.getMarkdown()).toBe(`Nouvelle Intro.\n\n${md}`);
    }
  });

  it("a changed width is written rounded, the rest of the page as it was", () => {
    const ed = load(
      `Avant.\n\n![[file:${FILE_ID}|33%]]\n\n![[file:${PAGE_ID}|300]]`,
    );
    let pos = -1;
    ed.state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === "noteImage") pos = p;
    });
    ed.commands.command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { id: FILE_ID, width: 45, raw: null });
      return true;
    });
    expect(ed.getMarkdown()).toBe(
      `Avant.\n\n![[file:${FILE_ID}|45%]]\n\n![[file:${PAGE_ID}|300]]`,
    );
  });

  it("![alt](url) stays kept as written, never an attachment", () => {
    const ed = load(PRESERVED.image);
    ed.state.doc.descendants((n) => {
      expect(n.type.name).not.toBe("noteImage");
    });
  });

  it("a table written by Claude is kept when the text around it changes", () => {
    const ed = load(MARKDOWN_FIXTURES.table);
    ed.commands.insertContentAt(1, "Juste ");
    expect(ed.getMarkdown()).toBe(
      "Juste Avant\n\n| Nom | Accès |\n| --- | --- |\n| VPS | ssh |\n\nAprès",
    );
  });

  it("[a][b] without a definition stays plain, editable text", () => {
    const ed = load("Le tableau [a][b] ici.");
    const types: string[] = [];
    ed.state.doc.descendants((n) => {
      if (n.isInline) types.push(n.type.name);
    });
    expect(types).toEqual(["text"]);
    expect(ed.state.doc.textContent).toBe("Le tableau [a][b] ici.");
  });

  it("typed text that looks like syntax stays text", () => {
    const ed = load("");
    ed.commands.insertContent({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: `[[page:${PAGE_ID}|x]] et ==pas== et <u>non</u>`,
        },
      ],
    });
    const md = ed.getMarkdown();
    expect(load(md).state.doc.textContent).toBe(
      `[[page:${PAGE_ID}|x]] et ==pas== et <u>non</u>`,
    );
  });
});

describe("image widths (task 8)", () => {
  it("reads a width in % within 10 to 100, nothing else", () => {
    expect(parseWidth("50%")).toBe(50);
    expect(parseWidth(" 40 %")).toBe(40);
    expect(parseWidth("250%")).toBe(100);
    expect(parseWidth("3%")).toBe(10);
    expect(parseWidth("300")).toBeNull();
    expect(parseWidth(null)).toBeNull();
  });

  it("a chosen width is rounded to 5 % and kept within 10 to 100 %", () => {
    expect(snapWidth(23)).toBe(25);
    expect(snapWidth(22.4)).toBe(20);
    expect(snapWidth(2)).toBe(10);
    expect(snapWidth(140)).toBe(100);
  });

  it("dragging the corner handle 200 px left from 400 px on an 800 px column gives 25 %", () => {
    expect(widthAfterDrag(400, -200, 800)).toBe(25);
    expect(widthAfterDrag(800, 0, 800)).toBe(100);
    expect(widthAfterDrag(400, 900, 800)).toBe(100);
    expect(widthAfterDrag(100, -100, 800)).toBe(10);
  });

  it("lists the attachment ids a page names", () => {
    expect([
      ...imageIdsIn(`a ![[file:${FILE_ID}|5%]] [[file:${PAGE_ID}]]`),
    ]).toEqual([FILE_ID, PAGE_ID]);
  });
});
