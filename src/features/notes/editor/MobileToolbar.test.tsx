/**
 * The phone's formatting bar: stuck on top of the
 * keyboard with `window.visualViewport`, shown only while the page is being written, never
 * left floating mid-screen once the keyboard closes.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fr } from "../../../i18n/fr";
import { noteExtensions } from "./extensions";
import { MobileToolbar } from "./MobileToolbar";
import { Toolbar } from "./Toolbar";

/** A visual viewport the test moves like a phone's keyboard does. */
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  width = 390;
  set(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

let viewport: FakeViewport;
let editor: Editor;
let host: HTMLElement;

beforeEach(() => {
  viewport = new FakeViewport();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 800,
  });
  host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: noteExtensions(),
    content: "Bonjour",
    contentType: "markdown",
  });
});

afterEach(() => {
  editor.destroy();
  host.remove();
});

/** Tiptap focuses on the next frame. */
async function focusPage(keyboard = 400) {
  await act(async () => {
    editor.commands.focus();
    await new Promise((r) => setTimeout(r, 20));
    viewport.set(keyboard);
  });
}

function bar() {
  return screen.queryByRole("toolbar", { name: fr.notes.editor.toolbar });
}

describe("MobileToolbar", () => {
  it("sits right on top of the keyboard while the page is being written", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    const toolbar = bar();
    expect(toolbar).not.toBeNull();
    expect(toolbar?.style.bottom).toBe("400px");
    // The browser scrolls the visual viewport: the bar follows it.
    act(() => viewport.set(400, 30));
    expect(bar()?.style.bottom).toBe("370px");
  });

  it("no home-indicator gap above the keyboard; a notice shows right above the buttons", async () => {
    render(<MobileToolbar editor={editor} notice={<p>Attention</p>} />);
    await focusPage();
    expect(bar()).not.toHaveClass("pb-[env(safe-area-inset-bottom)]");
    expect(bar()).toHaveTextContent("Attention");
  });

  it("hides when the keyboard closes, and when the page loses the focus", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    expect(bar()).not.toBeNull();
    // Android's back button closes the keyboard but leaves the focus in the page.
    act(() => viewport.set(800));
    expect(bar()).toBeNull();
    act(() => viewport.set(400));
    expect(bar()).not.toBeNull();
    act(() => {
      editor.commands.blur();
      (editor.view.dom as HTMLElement).blur();
    });
    expect(bar()).toBeNull();
  });

  it("has buttons of 44 × 44 px at least, and « Aa » for the other styles", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(8);
    for (const b of buttons) expect(b).toHaveClass("h-11", "min-w-11");
    expect(
      screen.queryByRole("button", { name: fr.notes.editor.underline }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: fr.notes.editor.more }));
    expect(
      screen.getByRole("button", { name: fr.notes.editor.underline }),
    ).toBeInTheDocument();
  });

  it("has an image button of 44 px that keeps the page's focus", async () => {
    let picked = 0;
    render(<MobileToolbar editor={editor} onImage={() => picked++} />);
    await focusPage();
    const image = screen.getByRole("button", { name: fr.notes.image.add });
    expect(image).toHaveClass("h-11", "min-w-11");
    const down = fireEvent.pointerDown(image);
    expect(down).toBe(false);
    fireEvent.click(image);
    expect(picked).toBe(1);
  });

  it("a button formats without taking the focus from the page (the keyboard stays)", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    act(() => {
      editor.commands.selectAll();
    });
    const bold = screen.getByRole("button", { name: fr.notes.editor.bold });
    const down = fireEvent.pointerDown(bold);
    // The press is cancelled so the editor keeps the focus.
    expect(down).toBe(false);
    fireEvent.click(bold);
    expect(editor.getMarkdown()).toBe("**Bonjour**");
  });

  it("« Masquer le clavier » leaves the page", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: fr.notes.editor.hideKeyboard }),
      );
    });
    expect(editor.isFocused).toBe(false);
    expect(bar()).toBeNull();
  });

  it("keeps « Annuler » next to « Masquer le clavier », out of the scrolling row", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    const undo = screen.getByRole("button", { name: fr.notes.editor.undo });
    const hide = screen.getByRole("button", {
      name: fr.notes.editor.hideKeyboard,
    });
    expect(undo.closest(".note-bar-scroll")).toBeNull();
    expect(undo.nextElementSibling).toBe(hide);
    expect(
      screen
        .getByRole("button", { name: fr.notes.editor.bold })
        .closest(".note-bar-scroll"),
    ).not.toBeNull();
  });

  it("publishes its real height for the sheet and the caret's margin (« Aa » row included)", async () => {
    let height = 45;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute("role") === "toolbar"
        ? ({
            height,
            width: 390,
            top: 0,
            left: 0,
            right: 390,
            bottom: height,
          } as DOMRect)
        : rect.call(this);
    };
    try {
      render(<MobileToolbar editor={editor} />);
      await focusPage();
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--note-toolbar")).toBe("45px");
      expect(editor.options.editorProps.scrollMargin).toMatchObject({
        bottom: 61,
      });
      height = 90;
      fireEvent.click(
        screen.getByRole("button", { name: fr.notes.editor.more }),
      );
      expect(root.style.getPropertyValue("--note-toolbar")).toBe("90px");
      expect(editor.options.editorProps.scrollThreshold).toMatchObject({
        bottom: 106,
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });

  it("« Titre » says and shows the level of the line", async () => {
    render(<MobileToolbar editor={editor} />);
    await focusPage();
    const title = () => screen.getByRole("button", { name: /^Titre \(/ });
    expect(title()).toHaveAccessibleName(fr.notes.editor.headingNow(0));
    fireEvent.click(title());
    expect(title()).toHaveAccessibleName(fr.notes.editor.headingNow(1));
    fireEvent.click(title());
    expect(title()).toHaveAccessibleName(fr.notes.editor.headingNow(2));
  });
});

describe("Toolbar (large screen)", () => {
  it("is one tab stop; ← → Début Fin move along its buttons", () => {
    render(<Toolbar editor={editor} onImage={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[0]]);
    act(() => buttons[0].focus());
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
    fireEvent.keyDown(buttons[1], { key: "End" });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(buttons.at(-1) as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons.at(-1));
  });
});
