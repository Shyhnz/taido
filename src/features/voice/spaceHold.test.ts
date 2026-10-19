import { describe, expect, it, vi } from "vitest";
import { HOLD_MS, type KeyLike, SpaceHold } from "./spaceHold";

function key(type: string, k = " ", extra: Partial<KeyLike> = {}): KeyLike {
  return {
    type,
    key: k,
    code: k === " " ? "Space" : `Key${k.toUpperCase()}`,
    repeat: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...extra,
  };
}

function setup() {
  vi.useFakeTimers();
  const log: string[] = [];
  const hold = new SpaceHold({
    start: (id) => log.push(`start ${id}`),
    stop: () => log.push("stop"),
    typeSpace: (id) => log.push(`space ${id}`),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  return { hold, log };
}

describe("SpaceHold", () => {
  it("a short press types one space", () => {
    const { hold, log } = setup();
    expect(hold.handle("t1", key("keydown"), true)).toBe(true);
    expect(hold.handle("t1", key("keypress"), true)).toBe(true);
    vi.advanceTimersByTime(HOLD_MS - 50);
    expect(hold.handle("t1", key("keyup"), true)).toBe(true);
    expect(log).toEqual(["space t1"]);
  });

  it("a long press dictates until release, repeats swallowed", () => {
    const { hold, log } = setup();
    hold.handle("t1", key("keydown"), true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.holding).toBe(true);
    expect(hold.handle("t1", key("keydown", " ", { repeat: true }), true)).toBe(
      true,
    );
    hold.handle("t1", key("keyup"), true);
    expect(log).toEqual(["start t1", "stop"]);
    expect(hold.holding).toBe(false);
  });

  it("typing fast keeps the order: the space goes before the next letter", () => {
    const { hold, log } = setup();
    hold.handle("t1", key("keydown"), true);
    expect(hold.handle("t1", key("keydown", "w"), true)).toBe(false);
    expect(log).toEqual(["space t1"]);
    vi.advanceTimersByTime(HOLD_MS * 2);
    hold.handle("t1", key("keyup"), true);
    expect(log).toEqual(["space t1"]);
  });

  it("does nothing when disabled or with a modifier", () => {
    const { hold, log } = setup();
    expect(hold.handle("t1", key("keydown"), false)).toBe(false);
    expect(
      hold.handle("t1", key("keydown", " ", { shiftKey: true }), true),
    ).toBe(false);
    expect(hold.handle("t1", key("keyup"), true)).toBe(false);
    expect(log).toEqual([]);
  });

  it("losing the focus ends cleanly", () => {
    const { hold, log } = setup();
    hold.handle("t1", key("keydown"), true);
    vi.advanceTimersByTime(HOLD_MS);
    hold.blur();
    expect(log).toEqual(["start t1", "stop"]);
    hold.handle("t1", key("keydown"), true);
    hold.blur();
    expect(log).toEqual(["start t1", "stop", "space t1"]);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual(["start t1", "stop", "space t1"]);
  });
});
