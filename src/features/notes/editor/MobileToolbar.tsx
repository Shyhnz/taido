/**
 * The formatting bar of a page on the phone: stuck on top
 * of the keyboard (`window.visualViewport` tells where the keyboard starts), shown only while
 * the page is being written and the keyboard is open, 44 × 44 px buttons, the less used
 * styles behind « Aa », scrolling sideways when the screen is narrow.
 */

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Brackets,
  ChevronDown,
  Heading,
  Heading1,
  Heading2,
  ImagePlus,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { fr } from "../../../i18n/fr";
import { ACTIONS, type ActionId, activeActions } from "./actions";
import { startWikiLink } from "./linkSuggest";
import { ToolbarButton, useRovingToolbar } from "./Toolbar";

/** Room kept between the caret and the bar above the keyboard (px). */
const CARET_ROOM = 16;

const MAIN: ActionId[] = [
  "bold",
  "italic",
  "highlight",
  "taskList",
  "bulletList",
  "heading",
];
const MORE: ActionId[] = ["underline", "strike", "quote", "code", "link"];

/** Below this, the visual viewport's missing height is browser chrome, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/** Height hidden at the bottom of the window by the keyboard (0 when it is closed). */
export function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/** The keyboard's height, followed as it opens, closes and the page scrolls under it. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(keyboardInset);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset());
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/** True while the editor holds the focus. */
function useFocused(editor: Editor): boolean {
  const [focused, setFocused] = useState(() => editor.isFocused);
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    editor.on("focus", on);
    editor.on("blur", off);
    setFocused(editor.isFocused);
    return () => {
      editor.off("focus", on);
      editor.off("blur", off);
    };
  }, [editor]);
  return focused;
}

/** A precise pointer (mouse): no on-screen keyboard to wait for. */
function hasFinePointer(): boolean {
  return window.matchMedia?.("(pointer: fine)").matches ?? false;
}

export function MobileToolbar({
  editor,
  onImage,
  notice,
}: {
  editor: Editor;
  /** The image button: the phone's photos and camera. */
  onImage?: () => void;
  /** A message the writer must see (« Page trop longue »), right above the buttons. */
  notice?: ReactNode;
}) {
  const inset = useKeyboardInset();
  const focused = useFocused(editor);
  const [more, setMore] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const roving = useRovingToolbar(bar);
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      activeActions(e, [...MAIN, ...MORE, "heading1", "heading2"]),
  });
  const keyboard = inset >= KEYBOARD_MIN_PX || hasFinePointer();
  const hasNotice = notice !== null && notice !== undefined;
  const shown = focused && keyboard;

  // The sheet keeps room for the bar under the text (`--note-keyboard`).
  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.style.setProperty("--note-keyboard", `${inset}px`);
    else root.style.removeProperty("--note-keyboard");
    return () => {
      root.style.removeProperty("--note-keyboard");
    };
  }, [shown, inset]);

  useEffect(() => {
    if (!shown) setMore(false);
  }, [shown]);

  // The bar's real height (« Aa » row, a notice): the sheet keeps that much room under the
  // text (`--note-toolbar`) and the caret stays clear of it when the page scrolls to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `more` and `hasNotice` change its height
  useEffect(() => {
    const el = bar.current;
    const root = document.documentElement;
    const publish = (height: number) => {
      const h = Math.ceil(height);
      root.style.setProperty("--note-toolbar", `${h}px`);
      if (editor.isDestroyed) return;
      const margin = {
        top: CARET_ROOM,
        bottom: h + CARET_ROOM,
        left: 0,
        right: 0,
      };
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          scrollMargin: margin,
          scrollThreshold: margin,
        },
      });
    };
    if (!shown || !el) {
      root.style.removeProperty("--note-toolbar");
      return;
    }
    publish(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() =>
      publish(el.getBoundingClientRect().height),
    );
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--note-toolbar");
    };
    // Measured again when a row or the notice comes or goes (and on any resize).
  }, [shown, editor, more, hasNotice]);

  if (!shown) return null;

  const button = (id: ActionId) => {
    const a = ACTIONS[id];
    // « Titre » says (and shows) the level of the line now: Titre 1 → Titre 2 → texte.
    const level = on.heading1 ? 1 : on.heading2 ? 2 : 0;
    const heading = id === "heading";
    return (
      <ToolbarButton
        key={id}
        label={heading ? fr.notes.editor.headingNow(level) : a.label}
        title={heading ? a.label : undefined}
        pressed={on[id] === true}
        onPress={() => a.run(editor)}
        className="h-11 min-w-11"
      >
        {heading ? (
          level === 1 ? (
            <Heading1 size={18} aria-hidden />
          ) : level === 2 ? (
            <Heading2 size={18} aria-hidden />
          ) : (
            <Heading size={18} aria-hidden />
          )
        ) : (
          a.icon
        )}
      </ToolbarButton>
    );
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={fr.notes.editor.toolbar}
      aria-orientation="horizontal"
      onKeyDown={roving}
      style={{ bottom: `${inset}px` }}
      // The home indicator's room only matters with no keyboard under the bar (iOS gap).
      className={`fixed inset-x-0 z-[45] border-t border-border bg-bg ${
        inset > 0 ? "" : "pb-[env(safe-area-inset-bottom)]"
      }`}
    >
      {notice && <div className="px-2 pt-2">{notice}</div>}
      {more && (
        <div className="flex overflow-x-auto border-b border-border px-1">
          {MORE.map(button)}
        </div>
      )}
      <div className="flex items-center">
        {/* Scrolls sideways when narrow; the fade on its right edge says there is more. */}
        <div className="note-bar-scroll flex min-w-0 flex-1 items-center overflow-x-auto px-1">
          {MAIN.map(button)}
          {onImage && (
            <ToolbarButton
              label={fr.notes.image.add}
              onPress={onImage}
              className="h-11 min-w-11"
            >
              <ImagePlus size={18} aria-hidden />
            </ToolbarButton>
          )}
          <ToolbarButton
            label={fr.notes.editor.wikiLink}
            onPress={() => startWikiLink(editor)}
            className="h-11 min-w-11"
          >
            <Brackets size={18} aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label={fr.notes.editor.more}
            pressed={more}
            onPress={() => setMore((m) => !m)}
            className="h-11 min-w-11 text-[15px] font-semibold"
          >
            Aa
          </ToolbarButton>
        </div>
        {/* Always in reach, whatever the row scrolled to. */}
        <ToolbarButton
          label={fr.notes.editor.undo}
          onPress={() => editor.chain().focus().undo().run()}
          className="h-11 min-w-11 border-l border-border"
        >
          <Undo2 size={18} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={fr.notes.editor.hideKeyboard}
          onPress={() => {
            editor.commands.blur();
            (editor.view.dom as HTMLElement).blur();
          }}
          className="h-11 min-w-11"
        >
          <ChevronDown size={20} aria-hidden />
        </ToolbarButton>
      </div>
    </div>
  );
}
