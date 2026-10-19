import { describe, expect, it } from "vitest";
import { formatDroppedPaths } from "./droppedPaths";

describe("formatDroppedPaths", () => {
  it("types a plain path followed by a space", () => {
    expect(formatDroppedPaths(["/Users/user/notes.md"])).toBe(
      "/Users/user/notes.md ",
    );
  });

  it("escapes spaces and shell characters like Terminal.app", () => {
    expect(
      formatDroppedPaths(["/Users/user/Capture d’écran (1) & co's.png"]),
    ).toBe("/Users/user/Capture\\ d\\’écran\\ \\(1\\)\\ \\&\\ co\\'s.png ");
  });

  it("keeps accented letters as they are", () => {
    expect(formatDroppedPaths(["/tmp/Été/réunion.pdf"])).toBe(
      "/tmp/Été/réunion.pdf ",
    );
  });

  it("separates several paths with spaces", () => {
    expect(formatDroppedPaths(["/a/b.txt", "/c d/e.png"])).toBe(
      "/a/b.txt /c\\ d/e.png ",
    );
  });

  it("quotes Windows paths instead of escaping their backslashes", () => {
    expect(formatDroppedPaths(["C:\\Users\\user\\a.txt"])).toBe(
      "C:\\Users\\user\\a.txt ",
    );
    expect(formatDroppedPaths(["C:\\Mes documents\\a.txt"])).toBe(
      '"C:\\Mes documents\\a.txt" ',
    );
  });

  it("types nothing without paths", () => {
    expect(formatDroppedPaths([])).toBe("");
  });
});
