import { describe, expect, it } from "vitest";
import { projectPath, sectionPath, truncate } from "./format";

describe("truncate", () => {
  it("keeps short text unchanged", () => {
    expect(truncate("OK", 10)).toBe("OK");
  });

  it("cuts long text with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("projectPath", () => {
  const subjects = [
    { id: "globex", name: "Globex", parentId: null },
    { id: "admin", name: "Admin", parentId: "globex" },
  ];

  it("names a sub-project with its parent, a top-level project alone", () => {
    expect(projectPath(subjects[0], subjects)).toBe("Globex");
    expect(projectPath(subjects[1], subjects)).toBe("Globex › Admin");
    expect(sectionPath(subjects[1], { name: "Factures" }, subjects)).toBe(
      "Globex › Admin › Factures",
    );
  });
});
