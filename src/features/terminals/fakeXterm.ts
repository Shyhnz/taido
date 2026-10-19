/**
 * Test double of xterm.js for jsdom (no canvas, no WebGL, no font metrics). Records what the
 * registry does with each instance. Used by tests only (`setXtermFactory`).
 */

import type { Terminal } from "@xterm/xterm";
import type { XtermHandle } from "./xterm";

export interface FakeTerm {
  written: string;
  disposed: boolean;
  webgl: number;
  fits: number;
  textarea: HTMLTextAreaElement;
  type: (data: string) => void;
  keyHandler: ((e: KeyboardEvent) => boolean) | null;
}

export const fakeTerms: FakeTerm[] = [];

const decoder = new TextDecoder();

export function createFakeXterm(): XtermHandle {
  let onData: ((data: string) => void) | null = null;
  const textarea = document.createElement("textarea");
  textarea.setAttribute("aria-label", "Terminal input");
  const fake: FakeTerm = {
    written: "",
    disposed: false,
    webgl: 0,
    fits: 0,
    textarea,
    type: (data) => onData?.(data),
    keyHandler: null,
  };
  fakeTerms.push(fake);
  const term = {
    cols: 80,
    rows: 24,
    options: {},
    open(parent: HTMLElement) {
      const root = document.createElement("div");
      root.className = "xterm";
      root.appendChild(textarea);
      parent.appendChild(root);
    },
    onData(cb: (data: string) => void) {
      onData = cb;
      return { dispose: () => {} };
    },
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) {
      fake.keyHandler = cb;
    },
    write(data: string | Uint8Array) {
      fake.written += typeof data === "string" ? data : decoder.decode(data);
    },
    paste(data: string) {
      onData?.(data);
    },
    input(data: string) {
      onData?.(data);
    },
    focus() {
      textarea.focus();
    },
    hasSelection: () => false,
    getSelection: () => "",
    dispose() {
      fake.disposed = true;
    },
  } as unknown as Terminal;
  return {
    term,
    fit: () => {
      fake.fits += 1;
    },
    enableWebgl: () => {
      fake.webgl += 1;
      return () => {
        fake.webgl -= 1;
      };
    },
  };
}

export function resetFakeTerms(): void {
  fakeTerms.length = 0;
}
