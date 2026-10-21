import "./pin-language";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import {
  PANEL_FOLDS_KEY,
  usePanelFolds,
} from "../features/task-panel/PanelFold";

// Shared CI runners are slow: `waitFor` and `findBy` wait longer than their 1 s default.
if (process.env.CI) configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  // The panel's folds live in a module store: every test starts from the defaults.
  try {
    window.localStorage.removeItem(PANEL_FOLDS_KEY);
  } catch {
    // No storage in this environment.
  }
  usePanelFolds.setState({ stored: {}, forced: {} });
});

// jsdom has no matchMedia: the theme code and reduced-motion checks use it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom does not lay out: ProseMirror (the notebook's editor) measures ranges to scroll the
// caret into view and to place the `[[` list.
if (typeof Range !== "undefined") {
  const empty = () => new DOMRect(0, 0, 0, 0);
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = empty;
  }
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
  }
}
