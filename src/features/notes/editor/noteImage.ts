/**
 * An image of a page: `![[file:<id>|<l>%]]`, the
 * attachment `<id>` of the page shown at `<l>` % of the text column (so it fits from the Mac
 * to the phone), `100%` when absent. An inline atom: what the Markdown says is kept as written
 * (`raw`) until the user changes the width, which is then written rounded to 5 %, 10 to 100 %.
 * `![alt](url)` stays the `rawImage`'s (a web address is not an attachment).
 */

import { Node } from "@tiptap/core";

export {
  imageFileName,
  isPageImage,
  PAGE_IMAGE_MIMES,
  pageImageRefusal,
} from "../../../lib/mock-links";

const IMAGE = /^!\[\[file:([0-9a-f-]{36})(?:\|([^\]\n]*))?\]\]/;
const START = "![[file:";

export const MIN_WIDTH = 10;
export const MAX_WIDTH = 100;
const STEP = 5;

export interface NoteImageAttrs {
  id: string;
  /** Width in % of the column as written (10 to 100); `null` when the Markdown has none. */
  width: number | null;
  /** The Markdown as read, written back as long as the width is not changed. */
  raw: string | null;
}

/** `50%` → 50 (kept within 10 to 100 %); `null` for no width or another form (`300`). */
export function parseWidth(label: string | null | undefined): number | null {
  const m = /^\s*(\d{1,4}(?:[.,]\d+)?)\s*%\s*$/.exec(label ?? "");
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

/** A width the user chose: rounded to 5 %, between 10 and 100 %. */
export function snapWidth(percent: number): number {
  if (!Number.isFinite(percent)) return MAX_WIDTH;
  const snapped = Math.round(percent / STEP) * STEP;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, snapped));
}

/** The width after the corner handle moved `dx` px, from `startPx` wide in a `columnPx` column. */
export function widthAfterDrag(
  startPx: number,
  dx: number,
  columnPx: number,
): number {
  if (columnPx <= 0) return MAX_WIDTH;
  return snapWidth(((startPx + dx) / columnPx) * 100);
}

/** The width shown: as written, 100 % without one. */
export const shownWidth = (width: number | null | undefined): number =>
  width ?? MAX_WIDTH;

/** The image at the start of `src`. */
export function readNoteImage(
  src: string,
): (NoteImageAttrs & { raw: string }) | null {
  const m = IMAGE.exec(src);
  if (!m) return null;
  return { raw: m[0], id: m[1], width: parseWidth(m[2]) };
}

export function noteImageMarkdown(id: string, width: number | null): string {
  return width === null ? `![[file:${id}]]` : `![[file:${id}|${width}%]]`;
}

/** The attachment ids a page's Markdown shows or names (`file:<id>`). */
export function imageIdsIn(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/file:([0-9a-f-]{36})/g)) out.add(m[1]);
  return out;
}

export interface NoteImageOptions {
  /** The page whose attachments the images are. */
  pageId: string;
  /** The phone's sheet: sizes by touch, no corner handle. */
  phone: boolean;
}

export const NoteImage = Node.create<NoteImageOptions>({
  name: "noteImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { pageId: "", phone: false };
  },

  addAttributes() {
    return {
      id: { default: "" },
      width: { default: null },
      raw: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-note-image]",
        getAttrs: (el) => {
          const width = Number.parseInt(
            el.getAttribute("data-width") ?? "",
            10,
          );
          return {
            id: el.getAttribute("data-id") ?? "",
            width: Number.isFinite(width) ? width : null,
            raw: el.getAttribute("data-raw"),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "span",
      {
        "data-note-image": "",
        "data-id": node.attrs.id,
        "data-width": node.attrs.width,
        "data-raw": node.attrs.raw,
        style: `width: ${shownWidth(node.attrs.width)}%`,
      },
    ];
  },

  renderText() {
    return "";
  },

  markdownTokenizer: {
    name: "noteImage",
    level: "inline",
    start: (src: string) => src.indexOf(START),
    tokenize: (src: string) => {
      const image = readNoteImage(src);
      if (!image) return undefined;
      return {
        type: "noteImage",
        raw: image.raw,
        id: image.id,
        width: image.width,
      };
    },
  },

  parseMarkdown: (token) => ({
    type: "noteImage",
    attrs: { id: token.id, width: token.width ?? null, raw: token.raw },
  }),

  renderMarkdown: (node) => {
    const raw = node.attrs?.raw as string | null | undefined;
    if (raw) return raw;
    return noteImageMarkdown(
      String(node.attrs?.id ?? ""),
      (node.attrs?.width as number | null | undefined) ?? null,
    );
  },
});
