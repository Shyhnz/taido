/**
 * `[[page:<id>|Titre]]` and `[[task:<id>|Titre]]`: an inline
 * atom kept as written. The label is a readable copy; the chip shows the item's current title.
 * `![[file:…]]` (images, plan task 8) is not ours: the tokenizer never starts on `![[`.
 */

import { mergeAttributes, Node } from "@tiptap/core";

export type WikiLinkKind = "page" | "task";

export interface WikiLinkAttrs {
  kind: WikiLinkKind;
  id: string;
  /** The title copied in the Markdown; `null` when the link has none (`[[page:<id>]]`). */
  label: string | null;
}

/** `[[page:<uuid>]]` or `[[task:<uuid>|label]]`, at the start of `src`. */
const LINK = /^\[\[(page|task):([0-9a-f-]{36})(?:\|([^\]\n]*))?\]\]/;
const START = /(?<!!)\[\[(?:page|task):/;

/** Index of the first link start in `src` (not an image's `![[`), or -1. */
export function wikiLinkStart(src: string): number {
  const m = START.exec(src);
  return m ? m.index : -1;
}

/** The link at the start of `src`, with the text it takes. */
export function readWikiLink(
  src: string,
): (WikiLinkAttrs & { raw: string }) | null {
  const m = LINK.exec(src);
  if (!m) return null;
  return {
    raw: m[0],
    kind: m[1] as WikiLinkKind,
    id: m[2],
    label: m[3] ?? null,
  };
}

export function wikiLinkMarkdown(attrs: WikiLinkAttrs): string {
  return attrs.label === null
    ? `[[${attrs.kind}:${attrs.id}]]`
    : `[[${attrs.kind}:${attrs.id}|${attrs.label}]]`;
}

/** A label fit for the Markdown: no `]` (it would end the link) nor line break. */
export function linkLabel(title: string): string {
  return title.replace(/[\]\n\r|]+/g, " ").trim();
}

export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "page" },
      id: { default: "" },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-wiki-link]",
        getAttrs: (el) => ({
          kind: el.getAttribute("data-kind") ?? "page",
          id: el.getAttribute("data-id") ?? "",
          label: el.getAttribute("data-label"),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-wiki-link": "",
        "data-kind": node.attrs.kind,
        "data-id": node.attrs.id,
        "data-label": node.attrs.label,
      }),
      node.attrs.label ?? "",
    ];
  },

  renderText({ node }) {
    return node.attrs.label ?? "";
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (src: string) => wikiLinkStart(src),
    tokenize: (src: string) => {
      const link = readWikiLink(src);
      if (!link) return undefined;
      return {
        type: "wikiLink",
        raw: link.raw,
        kind: link.kind,
        id: link.id,
        label: link.label,
      };
    },
  },

  parseMarkdown: (token) => ({
    type: "wikiLink",
    attrs: { kind: token.kind, id: token.id, label: token.label ?? null },
  }),

  renderMarkdown: (node) =>
    wikiLinkMarkdown({
      kind: (node.attrs?.kind ?? "page") as WikiLinkKind,
      id: String(node.attrs?.id ?? ""),
      label: (node.attrs?.label as string | null | undefined) ?? null,
    }),
});
