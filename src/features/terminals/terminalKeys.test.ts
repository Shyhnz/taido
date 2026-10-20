import { describe, expect, it } from "vitest";
import { terminalKey } from "./terminalKeys";

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent("keydown", { key: k, ...mods });

describe("terminalKey", () => {
  it("on macOS, ⌘ keys belong to the app and ⌘C copies a selection", () => {
    expect(terminalKey(key("c", { metaKey: true }), "mac", true)).toBe("copy");
    expect(terminalKey(key("c", { metaKey: true }), "mac", false)).toBe("app");
    expect(terminalKey(key("t", { metaKey: true }), "mac", false)).toBe("app");
    // Ctrl stays the terminal's on macOS (Ctrl+C interrupts).
    expect(terminalKey(key("c", { ctrlKey: true }), "mac", true)).toBe(
      "terminal",
    );
    expect(terminalKey(key("a"), "mac", false)).toBe("terminal");
  });

  it("on Windows, Ctrl+C copies a selection, else interrupts; Ctrl+V pastes", () => {
    expect(terminalKey(key("c", { ctrlKey: true }), "windows", true)).toBe(
      "copy",
    );
    expect(terminalKey(key("c", { ctrlKey: true }), "windows", false)).toBe(
      "terminal",
    );
    expect(
      terminalKey(key("C", { ctrlKey: true, shiftKey: true }), "windows", true),
    ).toBe("copy");
    expect(terminalKey(key("v", { ctrlKey: true }), "windows", false)).toBe(
      "paste",
    );
    expect(
      terminalKey(
        key("V", { ctrlKey: true, shiftKey: true }),
        "windows",
        false,
      ),
    ).toBe("paste");
  });

  it("on Windows, the app's Ctrl shortcuts leave the terminal, the shell's stay", () => {
    for (const [k, shiftKey] of [
      ["t", false],
      ["T", true],
      ["F", true],
      ["{", true],
      ["}", true],
      ["1", false],
      ["3", false],
      [",", false],
    ] as const) {
      expect(
        terminalKey(key(k, { ctrlKey: true, shiftKey }), "windows", false),
        k,
      ).toBe("app");
    }
    // Readline / PSReadLine keys: Ctrl+K, Ctrl+N, Ctrl+R, Ctrl+D…
    for (const k of ["k", "n", "r", "d", "a", "l"]) {
      expect(terminalKey(key(k, { ctrlKey: true }), "windows", false), k).toBe(
        "terminal",
      );
    }
    expect(
      terminalKey(key("c", { ctrlKey: true, altKey: true }), "windows", true),
    ).toBe("terminal");
  });
});
