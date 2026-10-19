import { describe, expect, it } from "vitest";
import { cssPoint } from "./fileDrop";

describe("drop position", () => {
  it("keeps macOS points as they are, divides physical pixels elsewhere", () => {
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
    expect(cssPoint({ x: 600, y: 400 }, true)).toEqual([600, 400]);
    expect(cssPoint({ x: 600, y: 400 }, false)).toEqual([300, 200]);
  });
});
