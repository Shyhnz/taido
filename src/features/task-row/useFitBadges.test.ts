import { describe, expect, it } from "vitest";
import { fitBadges } from "./useFitBadges";

/** A line of `room` px holding a title of 40 and the badges' widths (jsdom has no layout). */
function line(width: number, widths: number[], relations: number[] = []) {
  let room = width;
  const row = document.createElement("div");
  const box = document.createElement("span");
  row.appendChild(box);
  const badges = widths.map((w, i) => {
    const b = document.createElement("span");
    b.dataset.width = String(w);
    if (relations.includes(i)) b.setAttribute("data-relation", "");
    box.appendChild(b);
    return b;
  });
  const used = () =>
    40 +
    badges
      .filter((b) => b.style.display !== "none")
      .reduce((n, b) => n + Number(b.dataset.width), 0);
  Object.defineProperty(row, "clientWidth", { get: () => room });
  Object.defineProperty(row, "scrollWidth", {
    get: () => Math.max(room, used()),
  });
  return {
    box,
    shown: () => badges.map((b) => b.style.display !== "none"),
    widen: (to: number) => {
      room = to;
    },
  };
}

describe("fitBadges", () => {
  it("keeps every badge when they fit", () => {
    const l = line(200, [20, 30, 40]);
    fitBadges(l.box);
    expect(l.shown()).toEqual([true, true, true]);
  });

  it("hides whole badges from the end, the relation icons last", () => {
    const l = line(100, [20, 30, 25, 25], [0]);
    fitBadges(l.box);
    // 40 + 20 (relation) + 30 = 90: the last two go.
    expect(l.shown()).toEqual([true, true, false, false]);
    const tight = line(65, [20, 30, 25], [0]);
    fitBadges(tight.box);
    expect(tight.shown()).toEqual([true, false, false]);
  });

  it("shows the badges again when the room comes back", () => {
    const l = line(60, [20, 30]);
    fitBadges(l.box);
    expect(l.shown()).toEqual([true, false]);
    l.widen(300);
    fitBadges(l.box);
    expect(l.shown()).toEqual([true, true]);
  });
});
