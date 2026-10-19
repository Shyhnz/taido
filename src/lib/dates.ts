/**
 * Date formatting for the UI, with date-fns in the active language (English or French).
 * Every function takes an optional `now` so tests can pin the clock.
 * Timestamps are ISO UTC strings; due dates are local `YYYY-MM-DD` / `HH:MM`.
 */

import {
  addDays,
  differenceInCalendarDays,
  differenceInMinutes,
  format,
  isSameYear,
  parseISO,
} from "date-fns";
import { enUS, fr as frLocale } from "date-fns/locale";
import { currentLanguage, t } from "../i18n";

/** date-fns locale of the active language. */
const locale = () => (currentLanguage() === "fr" ? frLocale : enUS);

const capitalize = (s: string) =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);

/** Parses a local `YYYY-MM-DD` date (no timezone shift). */
export function parseLocalDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Local `YYYY-MM-DD` of a date. */
export function toLocalDateString(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** Local `HH:MM` of a date. */
export function toLocalTimeString(date: Date): string {
  return format(date, "HH:mm");
}

/** "Jeudi 1 octobre" (year added when not the current one). */
export function formatLongDate(
  date: string | Date,
  now: Date = new Date(),
): string {
  const d = typeof date === "string" ? parseLocalDate(date) : date;
  const pattern = isSameYear(d, now) ? "EEEE d MMMM" : "EEEE d MMMM yyyy";
  return capitalize(format(d, pattern, { locale: locale() }));
}

/** "12 oct." (year added when not the current one). */
export function formatShortDate(date: Date, now: Date = new Date()): string {
  const pattern = isSameYear(date, now) ? "d MMM" : "d MMM yyyy";
  return format(date, pattern, { locale: locale() });
}

/**
 * Relative instant: "à l'instant", "il y a 8 min", "il y a 2 h" (same day),
 * "hier 17:42", then "12 oct. 17:42".
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const at = parseISO(iso);
  const minutes = differenceInMinutes(now, at);
  const days = differenceInCalendarDays(now, at);
  if (minutes < 1 && minutes > -1) return t.dates.justNow;
  if (minutes >= 1 && minutes < 60) return t.dates.minutesAgo(minutes);
  if (days === 0 && minutes >= 60) {
    return t.dates.hoursAgo(Math.floor(minutes / 60));
  }
  const time = toLocalTimeString(at);
  if (days === 1) return t.dates.yesterdayAt(time);
  return `${formatShortDate(at, now)} ${time}`;
}

/**
 * Journal date column: "il y a 8 min",
 * then "Aujourd'hui 22:31", "Hier 17:42", "12 oct. 17:42".
 */
export function formatJournalDate(iso: string, now: Date = new Date()): string {
  const at = parseISO(iso);
  const minutes = differenceInMinutes(now, at);
  const days = differenceInCalendarDays(now, at);
  if (minutes < 1 && minutes > -1) return capitalize(t.dates.justNow);
  if (minutes >= 1 && minutes < 60) {
    return capitalize(t.dates.minutesAgo(minutes));
  }
  const time = toLocalTimeString(at);
  if (days === 0) return capitalize(t.dates.todayAt(time));
  if (days === 1) return capitalize(t.dates.yesterdayAt(time));
  return `${formatShortDate(at, now)} ${time}`;
}

/**
 * Start of a Claude session in the history: "aujourd'hui 14:02",
 * "hier 09:34", then "12 oct. 14:02".
 */
export function formatSessionStart(
  iso: string,
  now: Date = new Date(),
): string {
  const at = parseISO(iso);
  const days = differenceInCalendarDays(now, at);
  const time = toLocalTimeString(at);
  if (days === 0) return t.dates.todayAt(time);
  if (days === 1) return t.dates.yesterdayAt(time);
  return `${formatShortDate(at, now)} ${time}`;
}

/** Length of a session: "moins d'1 min", "12 min", "1 h 05". */
export function formatSessionDuration(
  startIso: string,
  endIso: string,
): string {
  const minutes = Math.max(
    0,
    differenceInMinutes(parseISO(endIso), parseISO(startIso)),
  );
  if (minutes < 1) return t.sessions.durationUnderMinute;
  if (minutes < 60) return t.sessions.durationMinutes(minutes);
  const h = Math.floor(minutes / 60);
  return t.sessions.durationHours(h, minutes - h * 60);
}

/**
 * Label of a due date: "Aujourd'hui", "Demain", "Hier", the weekday within the
 * next 6 days ("Lundi"), otherwise "12 oct.".
 */
export function formatDueDate(date: string, now: Date = new Date()): string {
  const d = parseLocalDate(date);
  const diff = differenceInCalendarDays(d, now);
  if (diff === 0) return t.dates.today;
  if (diff === 1) return t.dates.tomorrow;
  if (diff === -1) return t.dates.yesterday;
  if (diff > 1 && diff < 7) {
    return capitalize(format(d, "EEEE", { locale: locale() }));
  }
  return formatShortDate(d, now);
}

/** Full due label: "Demain 17:00", "Aujourd'hui", "12 oct. 9:00". */
export function formatDue(
  due: { date: string; time: string | null },
  now: Date = new Date(),
): string {
  const label = formatDueDate(due.date, now);
  return due.time ? `${label} ${due.time}` : label;
}

/** Due label for a task row: just "14:00" for today with a time (wireframe 1). */
export function formatDueMeta(
  due: { date: string; time: string | null },
  now: Date = new Date(),
): string {
  if (
    due.time &&
    differenceInCalendarDays(parseLocalDate(due.date), now) === 0
  ) {
    return due.time;
  }
  return formatDue(due, now);
}

/** Today and tomorrow as local `YYYY-MM-DD` (due date shortcuts). */
export function todayString(now: Date = new Date()): string {
  return toLocalDateString(now);
}

export function tomorrowString(now: Date = new Date()): string {
  return toLocalDateString(addDays(now, 1));
}
