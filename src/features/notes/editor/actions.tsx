/**
 * The formatting actions shared by the page's two toolbars (top of the page on a large
 * screen, above the keyboard on the phone): label, icon, what it does, whether it is on.
 */

import type { Editor } from "@tiptap/core";
import {
  Bold,
  Code,
  Heading,
  Heading1,
  Heading2,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline,
} from "lucide-react";
import type { ReactNode } from "react";
import { promptDialog } from "../../../components/Dialog";
import { t } from "../../../i18n";

export type ActionId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "highlight"
  | "heading1"
  | "heading2"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "quote"
  | "code"
  | "link";

export interface FormatAction {
  id: ActionId;
  label: string;
  /** Shortcut shown in the tooltip on the Mac. */
  keys?: string;
  icon: ReactNode;
  run: (editor: Editor) => void;
  active: (editor: Editor) => boolean;
}

const ICON = 18;

/** Titre 1 → Titre 2 → plain text → Titre 1 (one button on the phone). */
function cycleHeading(editor: Editor): void {
  const chain = editor.chain().focus();
  if (editor.isActive("heading", { level: 1 })) {
    chain.setHeading({ level: 2 }).run();
  } else if (editor.isActive("heading", { level: 2 })) {
    chain.setParagraph().run();
  } else {
    chain.setHeading({ level: 1 }).run();
  }
}

/** Asks for the address of a web link; an empty one removes the link. */
export async function editWebLink(editor: Editor): Promise<void> {
  const current =
    (editor.getAttributes("link").href as string | undefined) ?? "";
  const values = await promptDialog({
    title: t.notes.editor.link,
    fields: [
      {
        name: "url",
        label: t.notes.editor.linkUrl,
        initial: current,
        placeholder: "https://",
        help: t.notes.editor.linkUrlHint,
      },
    ],
  });
  if (values === null) {
    editor.commands.focus();
    return;
  }
  const url = (values.url ?? "").trim();
  const chain = editor.chain().focus().extendMarkRange("link");
  if (url.length === 0) {
    chain.unsetLink().run();
    return;
  }
  const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  if (editor.state.selection.empty && !editor.isActive("link")) {
    // Nothing selected: the address itself becomes the link's text.
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: url,
        marks: [{ type: "link", attrs: { href } }],
      })
      .unsetMark("link")
      .run();
    return;
  }
  chain.setLink({ href }).run();
}

const mark = (
  id: ActionId,
  label: string,
  keys: string,
  icon: ReactNode,
  name: string,
  toggle: (e: Editor) => boolean,
): FormatAction => ({
  id,
  label,
  keys,
  icon,
  run: (e) => {
    toggle(e);
  },
  active: (e) => e.isActive(name),
});

export const ACTIONS: Record<ActionId, FormatAction> = {
  bold: mark(
    "bold",
    t.notes.editor.bold,
    "⌘B",
    <Bold size={ICON} />,
    "bold",
    (e) => e.chain().focus().toggleBold().run(),
  ),
  italic: mark(
    "italic",
    t.notes.editor.italic,
    "⌘I",
    <Italic size={ICON} />,
    "italic",
    (e) => e.chain().focus().toggleItalic().run(),
  ),
  underline: mark(
    "underline",
    t.notes.editor.underline,
    "⌘U",
    <Underline size={ICON} />,
    "underline",
    (e) => e.chain().focus().toggleUnderline().run(),
  ),
  strike: mark(
    "strike",
    t.notes.editor.strike,
    "⌘⇧S",
    <Strikethrough size={ICON} />,
    "strike",
    (e) => e.chain().focus().toggleStrike().run(),
  ),
  highlight: mark(
    "highlight",
    t.notes.editor.highlight,
    "⌘⇧H",
    <Highlighter size={ICON} />,
    "highlight",
    (e) => e.chain().focus().toggleHighlight().run(),
  ),
  heading1: {
    id: "heading1",
    label: t.notes.editor.heading1,
    keys: "# ",
    icon: <Heading1 size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleHeading({ level: 1 }).run();
    },
    active: (e) => e.isActive("heading", { level: 1 }),
  },
  heading2: {
    id: "heading2",
    label: t.notes.editor.heading2,
    keys: "## ",
    icon: <Heading2 size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleHeading({ level: 2 }).run();
    },
    active: (e) => e.isActive("heading", { level: 2 }),
  },
  heading: {
    id: "heading",
    label: t.notes.editor.heading,
    icon: <Heading size={ICON} />,
    run: cycleHeading,
    active: (e) => e.isActive("heading"),
  },
  bulletList: {
    id: "bulletList",
    label: t.notes.editor.bulletList,
    keys: "- ",
    icon: <List size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
    active: (e) => e.isActive("bulletList"),
  },
  orderedList: {
    id: "orderedList",
    label: t.notes.editor.orderedList,
    keys: "1. ",
    icon: <ListOrdered size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
    active: (e) => e.isActive("orderedList"),
  },
  taskList: {
    id: "taskList",
    label: t.notes.editor.taskList,
    keys: "[ ] ",
    icon: <ListChecks size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleTaskList().run();
    },
    active: (e) => e.isActive("taskList"),
  },
  quote: {
    id: "quote",
    label: t.notes.editor.quote,
    keys: "> ",
    icon: <Quote size={ICON} />,
    run: (e) => {
      e.chain().focus().toggleBlockquote().run();
    },
    active: (e) => e.isActive("blockquote"),
  },
  code: {
    id: "code",
    label: t.notes.editor.code,
    keys: "⌘E",
    icon: <Code size={ICON} />,
    run: (e) => {
      // Inside a line: inline code; on an empty line: a code block.
      const empty = e.state.selection.$from.parent.content.size === 0;
      if (empty || e.isActive("codeBlock")) {
        e.chain().focus().toggleCodeBlock().run();
      } else {
        e.chain().focus().toggleCode().run();
      }
    },
    active: (e) => e.isActive("code") || e.isActive("codeBlock"),
  },
  link: {
    id: "link",
    label: t.notes.editor.link,
    // No shortcut: ⌘K is the search everywhere in Taido.
    icon: <Link size={ICON} />,
    run: (e) => {
      void editWebLink(e);
    },
    active: (e) => e.isActive("link"),
  },
};

/** Which actions are on, read on every editor change (`useEditorState`). */
export function activeActions(
  editor: Editor | null,
  ids: ActionId[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!editor) return out;
  for (const id of ids) out[id] = ACTIONS[id].active(editor);
  return out;
}
