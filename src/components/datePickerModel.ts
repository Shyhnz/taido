/**
 * Pure helpers of the French date picker: month grid starting on Monday, quick
 * options and the free-text time field. Every function takes `now` so tests pin the clock.
 */

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  isSameMonth,
  nextMonday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { fr as frLocale } from "date-fns/locale";
import { parseLocalDate, toLocalDateString } from "../lib/dates";

/** Value edited by the picker: local `YYYY-MM-DD` date and optional `HH:MM` time. */
export interface DueValue {
  date: string | null;
  time: string | null;
}

const capitalize = (s: string) =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);

/** First day of the month containing `date`. */
export function monthOf(date: Date): Date {
  return startOfMonth(date);
}

/** Same month shifted by `delta` months. */
export function shiftMonth(month: Date, delta: number): Date {
  return startOfMonth(addMonths(month, delta));
}

export interface GridDay {
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Day of the month, 1–31. */
  day: number;
  /** False for the leading and trailing days of the neighbour months. */
  inMonth: boolean;
}

/** Six weeks of seven days, Monday first, covering the month of `month`. */
export function monthGrid(month: Date): GridDay[] {
  const first = startOfMonth(month);
  const start = startOfWeek(first, { weekStartsOn: 1 });
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return {
      date: toLocalDateString(d),
      day: d.getDate(),
      inMonth: isSameMonth(d, first),
    };
  });
}

/** Weekday headers, Monday first: short « Lu » and long « lundi ». */
export function weekdayLabels(): { short: string; long: string }[] {
  const monday = startOfWeek(new Date(2026, 0, 5), { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    return {
      short: capitalize(format(d, "EEEEEE", { locale: frLocale })),
      long: format(d, "EEEE", { locale: frLocale }),
    };
  });
}

/** « Octobre 2026 ». */
export function monthTitle(month: Date): string {
  return capitalize(format(month, "LLLL yyyy", { locale: frLocale }));
}

/** Accessible name of a day: « jeudi 1 octobre 2026 ». */
export function dayLabel(date: string): string {
  return format(parseLocalDate(date), "EEEE d MMMM yyyy", {
    locale: frLocale,
  });
}

/** Short hint shown next to a quick option: « ven. », « 5 oct. ». */
export function quickHint(date: string, now: Date = new Date()): string {
  const d = parseLocalDate(date);
  const diff = differenceInCalendarDays(d, now);
  return diff >= 0 && diff < 7
    ? format(d, "EEE", { locale: frLocale })
    : format(d, "d MMM", { locale: frLocale });
}

/** Quick options: today, tomorrow, next Monday (strictly after today, like Todoist). */
export function quickDates(now: Date = new Date()): {
  today: string;
  tomorrow: string;
  nextMonday: string;
} {
  return {
    today: toLocalDateString(now),
    tomorrow: toLocalDateString(addDays(now, 1)),
    nextMonday: toLocalDateString(nextMonday(now)),
  };
}

/** Date `delta` days after `date` (keyboard navigation in the grid). */
export function addDaysTo(date: string, delta: number): string {
  return toLocalDateString(addDays(parseLocalDate(date), delta));
}

/**
 * Parses the free-text time field: « 17 », « 17h », « 17h30 », « 17:30 », « 9.05 », « 0930 »,
 * and the 12-hour "5pm", "9:30am". Empty text means « no time » (`null`). Returns `undefined`
 * when the text is not a time.
 */
export function parseTime(text: string): string | null | undefined {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return null;
  const twelve = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/.exec(t);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (h < 1 || h > 12 || m > 59) return undefined;
    const hours = (h % 12) + (twelve[3] === "pm" ? 12 : 0);
    return `${String(hours).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const match =
    /^(\d{1,2})(?:\s*[h:.]\s*(\d{2})?)?$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
