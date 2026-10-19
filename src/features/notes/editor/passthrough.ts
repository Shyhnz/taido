/**
 * Markdown the editor does not edit but must keep as written, so that a page Claude or
 * Obsidian wrote survives a change elsewhere in it:
 * - `rawInline`: `![[…]]` embeds other than the page's images (`noteImage`), `[[…]]` that
 *   are not Taido links (Obsidian's `[[Une note]]`), Markdown images `![alt](url)`, inline
 *   HTML and comments, footnote marks `[^1]`, reference links (`ReferenceLink`) and entities
 *   (`&nbsp;`, shown as the character they stand for);
 * - `rawBlock`: tables, HTML blocks, link and footnote definitions (`[^1]: …`).
 * Both are atoms: shown as written, deleted whole.
 * `NoteMarkdownText` writes plain text with fewer entities than Tiptap (`2 < 3` stays as is).
 */

import { Extension, Node } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { readNoteImage } from "./noteImage";
import { readWikiLink } from "./wikiLink";

/** Inline syntaxes kept as written, each anchored at the start of the source. */
const RAW_INLINE = [
  // `![[Une note]]`, `[[Une note]]`.
  /^!?\[\[[^\]\n]+\]\]/,
  // Footnote mark `[^1]` (not its definition, a block).
  /^\[\^[^\]\s]+\](?!:)/,
  // Inline HTML comment, and HTML tags other than the underline's `<u>`, each on its own.
  /^<!--[\s\S]*?-->/,
  /^<\/?(?!u[\s/>])[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/,
  // Entity: `&nbsp;`, `&#8212;`, `&#x2014;`.
  /^&(?!(?:lt|gt|amp);)(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i,
];
const RAW_INLINE_START = /!?\[\[|\[\^|&#?\w|<[A-Za-z/!]/;
const ENTITY = /^&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});$/i;

const NAMED: Record<string, string> = {
  nbsp: "\u00a0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  euro: "€",
  thinsp: "\u2009",
  shy: "\u00ad",
};

/** What an entity stands for, to show it; `null` for other kept syntaxes. */
export function entityText(raw: string): string | null {
  if (!ENTITY.test(raw)) return null;
  const body = raw.slice(1, -1);
  if (body.startsWith("#")) {
    const code = /^#x/i.test(body)
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return null;
    }
  }
  return NAMED[body.toLowerCase()] ?? null;
}

const rawInlineNode = (raw: string) => ({
  type: "rawInline",
  attrs: { raw: raw.replace(/\s+$/, "") },
});

export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { raw: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-raw-inline]",
        getAttrs: (el) => ({ raw: el.getAttribute("data-raw") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    const entity = entityText(node.attrs.raw);
    return [
      "span",
      {
        "data-raw-inline": "",
        "data-raw": node.attrs.raw,
        class: entity === null ? "note-raw" : "note-entity",
        contenteditable: "false",
      },
      entity ?? node.attrs.raw,
    ];
  },

  renderText({ node }) {
    return entityText(node.attrs.raw) ?? node.attrs.raw;
  },

  markdownTokenizer: {
    name: "rawInline",
    level: "inline",
    start: (src: string) => {
      const m = RAW_INLINE_START.exec(src);
      return m ? m.index : -1;
    },
    tokenize: (src: string) => {
      // Taido's own links and images are the `wikiLink` and `noteImage` nodes'.
      if (readWikiLink(src) || readNoteImage(src)) return undefined;
      for (const re of RAW_INLINE) {
        const m = re.exec(src);
        if (m) return { type: "rawInline", raw: m[0], text: m[0] };
      }
      return undefined;
    },
  },

  parseMarkdown: (token) => ({
    type: "rawInline",
    attrs: { raw: token.raw },
  }),

  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  // marked's name for the tokens this node keeps; HTML blocks come through `RawHtmlBlock`.
  markdownTokenName: "table",

  addAttributes() {
    return { raw: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-raw-block]",
        preserveWhitespace: "full",
        getAttrs: (el) => ({ raw: el.getAttribute("data-raw") ?? "" }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "pre",
      {
        "data-raw-block": "",
        "data-raw": node.attrs.raw,
        class: "note-raw-block",
        contenteditable: "false",
      },
      node.attrs.raw,
    ];
  },

  parseMarkdown: (token) => ({
    type: "rawBlock",
    attrs: { raw: (token.raw ?? "").replace(/\s+$/, "") },
  }),

  renderMarkdown: (node) => String(node.attrs?.raw ?? ""),
});

/**
 * HTML kept as written, not reduced to its text: blocks (`<div>…</div>`, `<details>`,
 * comments) and inline tags (`<kbd>`, `<span …>`, `<br>`, comments), each tag on its own,
 * the text between them staying editable. `<u>` is the underline's.
 */
export const RawHtml = Extension.create({
  name: "rawHtml",
  markdownTokenName: "html",
  parseMarkdown: (token) => {
    const raw = (token.raw ?? "").replace(/\s+$/, "");
    if (raw.length === 0) return [];
    return token.block === true
      ? { type: "rawBlock", attrs: { raw } }
      : rawInlineNode(token.raw ?? "");
  },
});

/** Markdown images `![alt](url "titre")`: Tiptap has no node for them here. */
export const RawImage = Extension.create({
  name: "rawImage",
  markdownTokenName: "image",
  parseMarkdown: (token) => rawInlineNode(token.raw ?? ""),
});

/** Footnote definitions `[^1]: …` (and their indented lines), which marked reads as text. */
export const RawFootnoteDefinition = Extension.create({
  name: "rawFootnoteDefinition",
  markdownTokenName: "footnoteDefinition",
  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block",
    start: (src: string) => {
      const m = /(?:^|\n)\[\^[^\]\s]+\]:/.exec(src);
      if (!m) return -1;
      return src[m.index] === "\n" ? m.index + 1 : m.index;
    },
    tokenize: (src: string) => {
      const m = /^\[\^[^\]\s]+\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*)*/.exec(src);
      if (!m) return undefined;
      return { type: "footnoteDefinition", raw: m[0], text: m[0] };
    },
  },
  parseMarkdown: (token) => ({
    type: "rawBlock",
    attrs: { raw: (token.raw ?? "").replace(/\s+$/, "") },
  }),
});

/** Link and footnote definitions (`[id]: url`, `[^1]: …`), which marked would drop. */
export const RawDefinition = Extension.create({
  name: "rawDefinition",
  markdownTokenName: "def",
  parseMarkdown: (token) => {
    const raw = (token.raw ?? "").replace(/\s+$/, "");
    return raw.length > 0 ? { type: "rawBlock", attrs: { raw } } : [];
  },
});

/** `text` with the entities a Markdown reader needs, no more (the core's search reads it). */
export function encodeEntities(text: string): string {
  return text
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/<(?=[A-Za-z/!?])/g, "&lt;")
    .replace(/(^|\n)(\s*)>/g, "$1$2&gt;");
}

interface TextEncoderHost {
  codeTypes: Set<string>;
  escapeMarkdownSyntax: (text: string) => string;
  encodeTextForMarkdown: (
    text: string,
    node: { marks?: (string | { type: string })[] },
    parent?: { type?: string },
  ) => string;
}

export const NoteMarkdownText = Extension.create({
  name: "noteMarkdownText",
  // After `Markdown` (priority 100), which makes `editor.markdown` in its own `onBeforeCreate`.
  priority: 1,
  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: TextEncoderHost })
      .markdown;
    if (!manager) return;
    manager.encodeTextForMarkdown = (text, node, parent) => {
      const inCode =
        (parent?.type != null && manager.codeTypes.has(parent.type)) ||
        (node.marks ?? []).some((m) =>
          manager.codeTypes.has(typeof m === "string" ? m : m.type),
        );
      if (inCode) return text;
      // `==` would come back highlighted (Tiptap does not escape `=`).
      return manager
        .escapeMarkdownSyntax(encodeEntities(text))
        .replace(/==/g, "\\=\\=");
    };
  },
});

/** `[texte](url)`, not `[texte][id]`, `[texte][]` nor `[id]` (nor a bare `https://…`). */
const INLINE_LINK = /^\[[\s\S]*\]\(/;
const REFERENCE_LINK = /^\[[\s\S]*\](?:\[[^\]]*\])?$/;

/**
 * Web links. A reference link (`[texte][id]`, `[texte][]`, `[id]`) is kept as written, or it
 * would come back as `[texte](url)` next to its definition. marked only makes one when the
 * definition exists, so `[a][b]` without one stays plain text.
 */
export const ReferenceLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    const raw = token.raw ?? "";
    if (!INLINE_LINK.test(raw) && REFERENCE_LINK.test(raw)) {
      return rawInlineNode(raw);
    }
    return helpers.applyMark("link", helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: token.title || null,
    });
  },
});
