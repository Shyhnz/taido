/**
 * Underline written `<u>…</u>` in the Markdown (HTML that
 * Obsidian and GitHub read), instead of Tiptap's `++…++`, which would also underline the
 * text between two « C++ ».
 */

import BaseUnderline from "@tiptap/extension-underline";

const OPEN = "<u>";
const UNDERLINED = /^<u>([^\n]+?)<\/u>/;

export const Underline = BaseUnderline.extend({
  markdownTokenizer: {
    name: "underline",
    level: "inline",
    start: (src: string) => src.indexOf(OPEN),
    tokenize: (src, _tokens, lexer) => {
      const match = UNDERLINED.exec(src);
      if (!match) return undefined;
      return {
        type: "underline",
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
      };
    },
  },
  renderMarkdown: (node, helpers) => `<u>${helpers.renderChildren(node)}</u>`,
});
