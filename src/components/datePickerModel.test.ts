import { describe, expect, it } from "vitest";
import {
  addDaysTo,
  dayLabel,
  monthGrid,
  monthTitle,
  parseTime,
  quickDates,
  quickHint,
  shiftMonth,
  weekdayLabels,
} from "./datePickerModel";

// Thursday 1 October 2026, 22:40 local time.
const NOW = new Date(2026, 9, 1, 22, 40);

describe("monthGrid", () => {
  it("starts on the Monday before the 1st and covers six weeks", () => {
    const grid = monthGrid(new Date(2026, 9, 15));
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ date: "2026-09-28", day: 28, inMonth: false });
    expect(grid[3]).toEqual({ date: "2026-10-01", day: 1, inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
    expect(grid[41].date).toBe("2026-11-08");
  });

  it("starts on the 1st when the month begins on a Monday", () => {
    const grid = monthGrid(new Date(2026, 5, 1));
    expect(grid[0]).toEqual({ date: "2026-06-01", day: 1, inMonth: true });
  });
});

describe("labels", () => {
  it("lists weekdays Monday first, in French", () => {
    const labels = weekdayLabels();
    expect(labels.map((l) => l.short)).toEqual([
      "Lu",
      "Ma",
      "Me",
      "Je",
      "Ve",
      "Sa",
      "Di",
    ]);
    expect(labels[0].long).toBe("lundi");
    expect(labels[6].long).toBe("dimanche");
  });

  it("titles the month and names days", () => {
    expect(monthTitle(new Date(2026, 9, 1))).toBe("Octobre 2026");
    expect(dayLabel("2026-10-01")).toBe("jeudi 1 octobre 2026");
  });

  it("shifts months across years", () => {
    expect(monthTitle(shiftMonth(new Date(2026, 11, 31), 1))).toBe(
      "Janvier 2027",
    );
    expect(monthTitle(shiftMonth(new Date(2026, 0, 31), -1))).toBe(
      "Décembre 2025",
    );
  });
});

describe("quick options", () => {
  it("computes today, tomorrow and next Monday", () => {
    expect(quickDates(NOW)).toEqual({
      today: "2026-10-01",
      tomorrow: "2026-10-02",
      nextMonday: "2026-10-05",
    });
  });

  it("never picks today as next Monday", () => {
    // Monday 5 October 2026.
    expect(quickDates(new Date(2026, 9, 5, 9)).nextMonday).toBe("2026-10-12");
  });

  it("hints the weekday this week, else the date", () => {
    expect(quickHint("2026-10-02", NOW)).toBe("ven.");
    expect(quickHint("2026-10-12", NOW)).toBe("12 oct.");
  });

  it("moves by days across months", () => {
    expect(addDaysTo("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysTo("2026-10-01", -7)).toBe("2026-09-24");
  });
});

describe("parseTime", () => {
  it.each([
    ["17", "17:00"],
    ["17h", "17:00"],
    ["17H30", "17:30"],
    ["17h30", "17:30"],
    ["17:30", "17:30"],
    ["9:05", "09:05"],
    ["9.5", undefined],
    ["9.05", "09:05"],
    ["0930", "09:30"],
    [" 8 h ", "08:00"],
    ["0", "00:00"],
    ["5pm", "17:00"],
    ["9:30am", "09:30"],
    ["9.30 PM", "21:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
  ])("parses %s", (text, expected) => {
    expect(parseTime(text)).toBe(expected);
  });

  it("treats empty text as no time", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("   ")).toBeNull();
  });

  it.each(["24", "12:60", "midi", "17h3", "1:2:3", "13pm", "0am", "17h30pm"])(
    "rejects %s",
    (text) => {
      expect(parseTime(text)).toBeUndefined();
    },
  );
});
