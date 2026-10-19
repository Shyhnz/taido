import { describe, expect, it } from "vitest";
import {
  formatDue,
  formatDueDate,
  formatDueMeta,
  formatJournalDate,
  formatLongDate,
  formatRelative,
  formatSessionDuration,
  formatSessionStart,
  todayString,
  tomorrowString,
} from "./dates";

// Thursday 1 October 2026, 22:40 local time.
const NOW = new Date(2026, 9, 1, 22, 40);
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("formatLongDate", () => {
  it("formats the view subtitle date", () => {
    expect(formatLongDate("2026-10-01", NOW)).toBe("Jeudi 1 octobre");
    expect(formatLongDate("2026-10-12", NOW)).toBe("Lundi 12 octobre");
  });

  it("adds the year for another year", () => {
    expect(formatLongDate("2027-01-04", NOW)).toBe("Lundi 4 janvier 2027");
  });
});

describe("formatRelative", () => {
  it("handles very recent instants", () => {
    expect(formatRelative(local(2026, 10, 1, 22, 40), NOW)).toBe("à l'instant");
    expect(formatRelative(local(2026, 10, 1, 22, 32), NOW)).toBe(
      "il y a 8 min",
    );
  });

  it("uses hours within the same day", () => {
    expect(formatRelative(local(2026, 10, 1, 20, 30), NOW)).toBe("il y a 2 h");
  });

  it("uses yesterday with the time", () => {
    expect(formatRelative(local(2026, 9, 30, 17, 42), NOW)).toBe("hier 17:42");
  });

  it("falls back to a short date", () => {
    expect(formatRelative(local(2026, 9, 12, 9, 5), NOW)).toBe(
      "12 sept. 09:05",
    );
  });
});

describe("formatJournalDate", () => {
  it("is relative first, then absolute", () => {
    expect(formatJournalDate(local(2026, 10, 1, 22, 32), NOW)).toBe(
      "Il y a 8 min",
    );
    expect(formatJournalDate(local(2026, 10, 1, 9, 31), NOW)).toBe(
      "Aujourd'hui 09:31",
    );
    expect(formatJournalDate(local(2026, 9, 30, 17, 42), NOW)).toBe(
      "Hier 17:42",
    );
    expect(formatJournalDate(local(2026, 9, 2, 8, 0), NOW)).toBe(
      "2 sept. 08:00",
    );
  });
});

describe("due labels", () => {
  it("names nearby days", () => {
    expect(formatDueDate("2026-10-01", NOW)).toBe("Aujourd'hui");
    expect(formatDueDate("2026-10-02", NOW)).toBe("Demain");
    expect(formatDueDate("2026-09-30", NOW)).toBe("Hier");
  });

  it("uses the weekday within the coming week", () => {
    expect(formatDueDate("2026-10-05", NOW)).toBe("Lundi");
    expect(formatDueDate("2026-10-07", NOW)).toBe("Mercredi");
  });

  it("uses a short date further away", () => {
    expect(formatDueDate("2026-10-12", NOW)).toBe("12 oct.");
    expect(formatDueDate("2026-09-20", NOW)).toBe("20 sept.");
    expect(formatDueDate("2027-02-03", NOW)).toBe("3 févr. 2027");
  });

  it("adds the time", () => {
    expect(formatDue({ date: "2026-10-02", time: "17:00" }, NOW)).toBe(
      "Demain 17:00",
    );
    expect(formatDue({ date: "2026-10-01", time: null }, NOW)).toBe(
      "Aujourd'hui",
    );
  });

  it("shows only the time for today in rows", () => {
    expect(formatDueMeta({ date: "2026-10-01", time: "14:00" }, NOW)).toBe(
      "14:00",
    );
    expect(formatDueMeta({ date: "2026-10-01", time: null }, NOW)).toBe(
      "Aujourd'hui",
    );
    expect(formatDueMeta({ date: "2026-10-12", time: "09:00" }, NOW)).toBe(
      "12 oct. 09:00",
    );
  });

  it("gives today and tomorrow as local dates", () => {
    expect(todayString(NOW)).toBe("2026-10-01");
    expect(tomorrowString(NOW)).toBe("2026-10-02");
  });

  it("formats the start and the length of a Claude session", () => {
    const at = (d: number, h: number, m: number, month = 9) =>
      new Date(2026, month, d, h, m).toISOString();
    expect(formatSessionStart(at(1, 14, 2), NOW)).toBe("aujourd'hui 14:02");
    expect(formatSessionStart(at(30, 9, 34, 8), NOW)).toBe("hier 09:34");
    expect(formatSessionStart(at(12, 14, 2, 8), NOW)).toMatch(/^12 .+ 14:02$/);
    expect(formatSessionDuration(at(1, 14, 2), at(1, 14, 2))).toBe(
      "moins d'1 min",
    );
    expect(formatSessionDuration(at(1, 14, 2), at(1, 14, 14))).toBe("12 min");
    expect(formatSessionDuration(at(1, 14, 2), at(1, 15, 7))).toBe("1 h 05");
  });
});
