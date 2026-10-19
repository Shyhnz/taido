/**
 * The page editor's schema: Tiptap 3 stored as Markdown.
 * Bold, italic, underline (`<u>…</u>`), strike, `==highlight==`, headings, lists, task
 * lists, quote, code, web links, `[[…]]` links and the page's images `![[file:<id>|<l>%]]`.
 */

import type { AnyExtension } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { NoteImage } from "./noteImage";
import {
  NoteMarkdownText,
  RawBlock,
  RawDefinition,
  RawFootnoteDefinition,
  RawHtml,
  RawImage,
  RawInline,
  ReferenceLink,
} from "./passthrough";
import { Underline } from "./underline";
import { WikiLink } from "./wikiLink";

export interface NoteExtensionOptions {
  /** Grey text of an empty page. */
  placeholder?: string;
  /** Extra extensions (the `[[` suggestion, the chip's node view). */
  extra?: AnyExtension[];
  /** The `wikiLink` node to use (the editor's has a React node view). */
  wikiLink?: AnyExtension;
  /** The `noteImage` node to use (the editor's shows the image). */
  noteImage?: AnyExtension;
}

export function noteExtensions(
  opts: NoteExtensionOptions = {},
): AnyExtension[] {
  return [
    StarterKit.configure({
      // Ours: written `<u>…</u>` (Obsidian reads it), never `++…++` (« C++ et C++ »).
      underline: false,
      // An empty paragraph added at the end would be a change the user did not make.
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
      // Ours (`ReferenceLink`), configured the same way.
      link: false,
    }),
    ReferenceLink.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
    }),
    Underline,
    Highlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: opts.placeholder ?? "" }),
    opts.wikiLink ?? WikiLink,
    opts.noteImage ?? NoteImage,
    RawInline,
    RawBlock,
    RawHtml,
    RawImage,
    RawDefinition,
    RawFootnoteDefinition,
    NoteMarkdownText,
    Markdown.configure({
      indentation: { style: "space", size: 2 },
      markedOptions: { gfm: true, breaks: false },
    }),
    ...(opts.extra ?? []),
  ];
}
