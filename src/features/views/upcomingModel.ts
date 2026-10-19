/**
 * Pure helpers of « Prochainement »: weeks start
 * on Monday, the strip shows seven days, each day group is titled « 3 oct · Aujourd'hui ·
 * Samedi ». Every function takes `now` so tests pin the clock.
 */

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { fr as frLocale } from "date-fns/locale";
import { t } from "../../i18n";
import { parseLocalDate, toLocalDateString } from "../../lib/dates";

const capitalize = (s: string) =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);

/** Monday of the week containing `date` (`YYYY-MM-DD`). */
export function mondayOf(date: string): string {
  return toLocalDateString(
    startOfWeek(parseLocalDate(date), { weekStartsOn: 1 }),
  );
}

/** `date` moved by `days` days. */
export function shiftDays(date: string, days: number): string {
  return toLocalDateString(addDays(parseLocalDate(date), days));
}

/** The seven days of the week starting on `monday`. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDays(monday, i));
}

/**
 * Days asked to the core for the week of `monday`: the week, plus as many days as have
 * already passed in it, so the list always reaches a week ahead (on a Saturday: Saturday to
 * next Friday), like Todoist's endless list.
 */
export function upcomingRange(
  monday: string,
  today: string,
): { from: string; days: number } {
  const passed = Math.max(
    0,
    Math.min(
      7,
      differenceInCalendarDays(parseLocalDate(today), parseLocalDate(monday)),
    ),
  );
  return { from: monday, days: 7 + passed };
}

/** « 3 oct » (no trailing dot, like the screenshot). */
export function shortDate(date: string): string {
  return format(parseLocalDate(date), "d MMM", { locale: frLocale }).replace(
    /\.$/,
    "",
  );
}

/** « Samedi ». */
export function weekdayName(date: string): string {
  return capitalize(format(parseLocalDate(date), "EEEE", { locale: frLocale }));
}

/** « Lun » for the strip. */
export function weekdayShort(date: string): string {
  return capitalize(
    format(parseLocalDate(date), "EEE", { locale: frLocale }).replace(
      /\.$/,
      "",
    ),
  );
}

/** « Aujourd'hui », « Demain », or `null`. */
export function relativeDay(
  date: string,
  now: Date = new Date(),
): string | null {
  const diff = differenceInCalendarDays(parseLocalDate(date), now);
  if (diff === 0) return t.dates.today;
  if (diff === 1) return t.dates.tomorrow;
  return null;
}

/** Title of a day group: « 3 oct · Aujourd'hui · Samedi », « 5 oct · Lundi ». */
export function dayTitle(date: string, now: Date = new Date()): string {
  return t.upcoming.dayTitle(
    shortDate(date),
    relativeDay(date, now),
    weekdayName(date),
  );
}

/** Month of the picker button, from the week shown: « Octobre 2026 ». */
export function monthLabel(date: string): string {
  return capitalize(
    format(parseLocalDate(date), "LLLL yyyy", { locale: frLocale }),
  );
}

/** First day of the month of `date`: « 2026-10-01 ». */
export function monthOf(date: string): string {
  return toLocalDateString(startOfMonth(parseLocalDate(date)));
}

/** `month` (a first day) moved by `months` months. */
export function shiftMonths(month: string, months: number): string {
  return toLocalDateString(
    startOfMonth(addMonths(parseLocalDate(month), months)),
  );
}

/**
 * Days of the calendar of `month`: whole weeks, Monday first, from the week of the 1st to
 * the week of the last day (35 or 42 days, within the core's 62).
 */
export function calendarDays(month: string): string[] {
  const first = parseLocalDate(month);
  const start = startOfWeek(first, { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(first), { weekStartsOn: 1 });
  const count = differenceInCalendarDays(end, start) + 1;
  return Array.from({ length: count }, (_, i) =>
    toLocalDateString(addDays(start, i)),
  );
}

/** Range asked to the core for the calendar of `month`. */
export function calendarRange(month: string): { from: string; days: number } {
  const days = calendarDays(month);
  return { from: days[0], days: days.length };
}

/** « mercredi 14 octobre » (toast after a drop on a calendar day). */
export function longDay(date: string): string {
  return format(parseLocalDate(date), "EEEE d MMMM", { locale: frLocale });
}
