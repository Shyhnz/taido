import { describe, expect, it } from "vitest";
import { chronoSeconds, formatChrono, formatDuration } from "./chrono";

describe("chrono display", () => {
  it("formats like the wireframes", () => {
    expect(formatChrono(0)).toBe("0:00:00");
    expect(formatChrono(372)).toBe("0:06:12");
    expect(formatChrono(4532)).toBe("1:15:32");
    expect(formatDuration(2280)).toBe("0:38");
    expect(formatDuration(4200)).toBe("1:10");
  });

  it("adds the running segment up to now", () => {
    const now = new Date("2026-10-09T10:01:00.000Z");
    expect(chronoSeconds({ seconds: 100, runningSince: null }, now)).toBe(100);
    expect(
      chronoSeconds(
        { seconds: 100, runningSince: "2026-10-09T10:00:00.000Z" },
        now,
      ),
    ).toBe(160);
  });
});
