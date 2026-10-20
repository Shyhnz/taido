/**
 * The formatting bar on top of a page on a large screen:
 * fixed while the page scrolls, one button per style, the shortcut in its tooltip. A button
 * never takes the focus from the text. One tab stop: ← → (Début, Fin) move between buttons.
 */

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Brackets, ImagePlus } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import { t } from "../../../i18n";
import { keys as osKeys } from "../../../lib/platform";
import { ACTIONS, type ActionId, activeActions } from "./actions";
import { startWikiLink } from "./linkSuggest";

const GROUPS: ActionId[][] = [
  ["bold", "italic", "underline", "strike", "highlight"],
  ["heading1", "heading2"],
  ["bulletList", "orderedList", "taskList"],
  ["quote", "code", "link"],
];
const ALL = GROUPS.flat();

const buttonsOf = (bar: HTMLElement | null): HTMLButtonElement[] =>
  bar ? Array.from(bar.querySelectorAll<HTMLButtonElement>("button")) : [];

/**
 * Roving tab stop of a `role="toolbar"` (WAI-ARIA toolbar pattern): only one button is in the
 * Tab order (the last one used, else the first); ← → Début Fin move the focus along the bar.
 * Returns the bar's `onKeyDown`.
 */
export function useRovingToolbar(
  bar: RefObject<HTMLElement | null>,
): (e: KeyboardEvent) => void {
  const current = useRef(0);
  useLayoutEffect(() => {
    const buttons = buttonsOf(bar.current);
    const stop = Math.max(0, Math.min(current.current, buttons.length - 1));
    buttons.forEach((b, i) => {
      b.tabIndex = i === stop ? 0 : -1;
    });
  });
  return (e) => {
    const buttons = buttonsOf(bar.current);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || buttons.length === 0) return;
    const last = buttons.length - 1;
    const next =
      e.key === "ArrowRight"
        ? at === last
          ? 0
          : at + 1
        : e.key === "ArrowLeft"
          ? at === 0
            ? last
            : at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    current.current = next;
    buttons.forEach((b, i) => {
      b.tabIndex = i === next ? 0 : -1;
    });
    buttons[next].focus();
  };
}

export function ToolbarButton({
  label,
  title,
  pressed,
  onPress,
  className,
  children,
}: {
  label: string;
  title?: string;
  pressed?: boolean;
  onPress: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      // Keeps the focus (and the selection) in the text.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={`inline-flex shrink-0 items-center justify-center rounded-md ${
        pressed
          ? "bg-selected text-text"
          : "text-text-2 hover:bg-hover hover:text-text"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Toolbar({
  editor,
  onImage,
  notice,
}: {
  editor: Editor;
  /** The image button: picks images and adds them to the page. */
  onImage?: () => void;
  /** A message the writer must see (« Page trop longue »), kept in view with the bar. */
  notice?: ReactNode;
}) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => activeActions(e, ALL),
  });
  const bar = useRef<HTMLDivElement>(null);
  const roving = useRovingToolbar(bar);
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t.notes.editor.toolbar}
      aria-orientation="horizontal"
      onKeyDown={roving}
      className="sticky top-0 z-10 -mx-1 mb-3 flex flex-wrap items-center gap-0.5 border-b border-border bg-bg px-1 py-1.5"
    >
      {GROUPS.map((group, i) => (
        <Fragment key={group[0]}>
          {i > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
          {group.map((id) => {
            const a = ACTIONS[id];
            return (
              <ToolbarButton
                key={id}
                label={a.label}
                title={
                  a.keys ? `${a.label} (${osKeys(a.keys.trim())})` : a.label
                }
                pressed={on[id] === true}
                onPress={() => a.run(editor)}
                className="h-7 w-7"
              >
                {a.icon}
              </ToolbarButton>
            );
          })}
        </Fragment>
      ))}
      {onImage && (
        <ToolbarButton
          label={t.notes.image.add}
          onPress={onImage}
          className="h-7 w-7"
        >
          <ImagePlus size={18} aria-hidden />
        </ToolbarButton>
      )}
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        label={t.notes.editor.wikiLink}
        title={`${t.notes.editor.wikiLink} ([[)`}
        onPress={() => startWikiLink(editor)}
        className="h-7 w-7"
      >
        <Brackets size={18} aria-hidden />
      </ToolbarButton>
      {notice && <div className="mt-1.5 w-full">{notice}</div>}
    </div>
  );
}
