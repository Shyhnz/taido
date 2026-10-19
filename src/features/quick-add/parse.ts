/**
 * Parser of the quick add. Pure: it gets the
 * text, the date « now », the projects with their sections, and returns the title without the
 * recognised tokens, the destination, the due date, the agent to open and every token with its
 * position (for the live highlighting and the chips).
 *
 * Rules:
 * - `#Projet`, `#Projet/Section`: the longest existing name after `#`, without case or
 *   accents; otherwise one word, reported as `unknownProject` (« Créer « X » ? ») and kept in
 *   the title until the project exists. A sub-project is reached by its name
 *   or by `#Parent/Sous-projet` (and `#Parent/Sous-projet/Section`), which tells apart two
 *   sub-projects with the same name; a bare name shared by several projects goes to the
 *   top-level one, else the first in sidebar order. After `#Parent/`, a section of the parent
 *   wins over a sub-project of the same name.
 * - `/Section`: a section of the project named in the text, else of the current view's
 *   project (`contextSubjectId`). An unknown section stays plain text (`/tmp` in a title).
 * - `>claude`, `>codex`, `>shell` (not recognised when `agents` is false: the phone has no terminals).
 * - `!1`, `!2`, `!3`: the priority as shown, P1 the most urgent. It gives the stored value (`!1` → 4, red). `!4` (the default), `!5`, `!` alone
 *   or `!22` stay text.
 * - French dates and times; a time alone is for today, even when already past (like the date
 *   picker); `demain matin|midi|après-midi|soir` adds 09:00, 12:00, 14:00, 18:00. Taido V2.4:
 *   an optional `@` before them (`@vendredi`, `@13/10`, `@demain 10h`).
 * - The FIRST token of each kind wins (project, section, date, time, agent, priority); the later ones
 *   stay in the title as plain text (« Appeler Paul demain pour la réunion de lundi »). An
 *   explicit time wins over the time implied by « ce soir » or « demain matin ».
 * - Tokens start a word (start of text or after a space) and end before a space, the end of
 *   the text or a punctuation mark.
 */

import type { Section, Subject } from "../../bindings";
import { activeLanguage, type Language } from "../../i18n";

export type LaunchKind = "claude" | "codex" | "shell";

/** Stored priority a `!1`…`!3` token sets (`!1` → 4 … `!3` → 2; 1, the default P4, has no token). */
export type Priority = 2 | 3 | 4;

/** Due date found in the text: `YYYY-MM-DD`, and `HH:MM` when a time was given. */
export interface ParsedDue {
  date: string;
  time?: string;
}

/** Half-open range `[start, end)` of the text. */
export interface Range {
  start: number;
  end: number;
}

interface TokenBase extends Range {
  /** The token as typed. */
  text: string;
}

export type QuickToken =
  | (TokenBase & {
      kind: "project";
      /** `subjectId` null: no such project (`unknownProject`), the token stays in the title. */
      value: {
        subjectId: string | null;
        sectionId: string | null;
        name: string;
      };
    })
  | (TokenBase & {
      kind: "section";
      value: { subjectId: string; sectionId: string; name: string };
    })
  | (TokenBase & { kind: "agent"; value: LaunchKind })
  | (TokenBase & { kind: "priority"; value: Priority })
  | (TokenBase & {
      kind: "date";
      value: { date: string; time: string | null };
    })
  | (TokenBase & { kind: "time"; value: { time: string } });

export type TokenKind = QuickToken["kind"];

export interface ParseOptions {
  /** Project of the current view: `/Section` looks there when the text names no project. */
  contextSubjectId?: string | null;
  /** Ranges kept as plain text: a removed chip turns its tokens back into text. */
  literals?: Range[];
  /** `>claude` and `>shell` are recognised (default true; false where there are no terminals). */
  agents?: boolean;
  /** Language of the date and time words (default: the interface's, `activeLanguage`). */
  language?: Language;
}

export interface ParseResult {
  title: string;
  subject?: Subject;
  section?: Section;
  due?: ParsedDue;
  launch?: LaunchKind;
  /** Set by `!2`, `!3` or `!4`. */
  priority?: Priority;
  /** Recognised tokens (and the unknown project one), in text order. */
  tokens: QuickToken[];
  /** Name after `#` that matches no project: offered as « Créer « X » ? ». */
  unknownProject?: string;
  /**
   * Project whose sections `/Section` is read in: the one named in the text (null when it is
   * unknown), else the current view's. The `/` autocompletion offers the same sections.
   */
  slashSubject: Subject | null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Lower case without accents, same length as the input (indexes stay valid): « Après » →
 * « apres », the typographic apostrophe becomes a straight one.
 */
export function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "’" || ch === "‘") {
      out += "'";
      continue;
    }
    const folded = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (folded.length === 1) out += folded;
    else {
      const lower = ch.toLowerCase();
      out += lower.length === 1 ? lower : ch;
    }
  }
  return out;
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** A token may start at `i`: start of the text or after a space. */
const startsWord = (text: string, i: number) => i === 0 || isSpace(text[i - 1]);

/** A token may end at `j`: end of the text, a space or a punctuation mark. */
const endsWord = (text: string, j: number) =>
  j >= text.length || /[\s,.;:!?)]/.test(text[j]);

const pad = (n: number) => String(n).padStart(2, "0");

const ymd = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The date, or null when the day does not exist in that month (31 novembre). */
function makeDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  return d.getMonth() === month - 1 ? d : null;
}

const time = (h: number, m: number) =>
  h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** Weekday names, Sunday 0, in a regex alternation that tries the longest first. */
const weekdayRe = (days: Record<string, number>) =>
  Object.keys(days)
    .sort((a, b) => b.length - a.length)
    .join("|");

/** The next occurrence of `target`, never today. */
const nextWeekday = (today: Date, target: number) =>
  addDays(today, (target - today.getDay() + 7) % 7 || 7);

/** A month alternation from names and abbreviations, longest first so the regex prefers them. */
const monthRe = (months: [string, number][]) =>
  months
    .map(([name]) => name)
    .sort((a, b) => b.length - a.length)
    .join("|");

interface DateMatch {
  end: number;
  date: string;
  time: string | null;
}

type DateRule = {
  re: RegExp;
  /** Date of the match, null when it is not a real date. */
  resolve: (m: RegExpExecArray, today: Date) => Date | null;
  /** « ce soir » already carries its time. */
  time?: string;
  dayPart?: boolean;
  /**
   * An impossible date here (« le 30 fev », « 31/02 ») stays text: no later rule may read a
   * date from its prefix (« le 30 »).
   */
  final?: boolean;
};

type TimeRule = {
  re: RegExp;
  /** `HH:MM` of the match, null when it is not a real time. */
  resolve: (m: RegExpExecArray) => string | null;
};

/** The date and time words of one language. */
interface DateWords {
  dateRules: DateRule[];
  /** Part of the day after a date word: « demain soir », "tomorrow evening". */
  dayPartRe: RegExp;
  dayParts: Record<string, string>;
  timeRules: TimeRule[];
}

/** « le 12 », "the 12th": this month, or the next month that has that day once it is past. */
function dayOfMonth(day: number, today: Date): Date | null {
  for (let k = 0; k < 13; k++) {
    const month = new Date(today.getFullYear(), today.getMonth() + k, 1);
    const d = makeDate(month.getFullYear(), month.getMonth() + 1, day);
    if (d && d >= today) return d;
  }
  return null;
}

// --- French ---------------------------------------------------------------

const FR_WEEKDAYS: Record<string, number> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
};

const FR_MONTHS: [string, number][] = [
  ["septembre", 9],
  ["decembre", 12],
  ["novembre", 11],
  ["fevrier", 2],
  ["janvier", 1],
  ["juillet", 7],
  ["octobre", 10],
  ["avril", 4],
  ["janv", 1],
  ["fevr", 2],
  ["juil", 7],
  ["sept", 9],
  ["mars", 3],
  ["juin", 6],
  ["aout", 8],
  ["fev", 2],
  ["avr", 4],
  ["mai", 5],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
];
const FR_MONTH_OF = new Map(FR_MONTHS);

const FR: DateWords = {
  dateRules: [
    {
      re: /aujourd'hui|aujourdhui|auj/y,
      resolve: (_m, today) => today,
      dayPart: true,
    },
    { re: /ce\s+soir/y, resolve: (_m, today) => today, time: "18:00" },
    {
      re: /apres-demain|apres\s+demain/y,
      resolve: (_m, today) => addDays(today, 2),
      dayPart: true,
    },
    {
      re: /demain/y,
      resolve: (_m, today) => addDays(today, 1),
      dayPart: true,
    },
    {
      re: /dans\s+(\d{1,3}|un|une)\s+(jours?|semaines?)/y,
      resolve: (m, today) => {
        const n = m[1] === "un" || m[1] === "une" ? 1 : Number(m[1]);
        return addDays(today, m[2].startsWith("semaine") ? n * 7 : n);
      },
    },
    {
      // The next occurrence, never today; « lundi prochain » is the same day (like the date
      // picker's « Lundi prochain »: the Monday strictly after today).
      re: new RegExp(`(${weekdayRe(FR_WEEKDAYS)})(?:\\s+prochain)?`, "y"),
      resolve: (m, today) => nextWeekday(today, FR_WEEKDAYS[m[1]]),
      dayPart: true,
    },
    {
      re: new RegExp(
        `(?:le\\s+)?(\\d{1,2})(?:er)?\\s+(${monthRe(FR_MONTHS)})\\.?(?:\\s+(\\d{4}))?`,
        "y",
      ),
      resolve: (m, today) =>
        dayMonth(Number(m[1]), FR_MONTH_OF.get(m[2]) ?? 0, m[3], today),
      dayPart: true,
      final: true,
    },
    {
      re: /(?:le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?/y,
      resolve: (m, today) => dayMonth(Number(m[1]), Number(m[2]), m[3], today),
      dayPart: true,
      final: true,
    },
    {
      re: /le\s+(\d{1,2})(?:er)?/y,
      resolve: (m, today) => dayOfMonth(Number(m[1]), today),
      dayPart: true,
    },
  ],
  dayPartRe: /\s+(apres-midi|apres\s+midi|matin|midi|soir)/y,
  dayParts: {
    matin: "09:00",
    midi: "12:00",
    "apres-midi": "14:00",
    "apres midi": "14:00",
    soir: "18:00",
  },
  timeRules: [
    {
      re: /(?:a\s+)?(\d{1,2})\s?h(\d{2})?/y,
      resolve: (m) => time(Number(m[1]), Number(m[2] ?? "0")),
    },
    {
      re: /(?:a\s+)?(\d{1,2}):(\d{2})/y,
      resolve: (m) => time(Number(m[1]), Number(m[2])),
    },
  ],
};

// --- English --------------------------------------------------------------

const EN_WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const EN_MONTHS: [string, number][] = [
  ["january", 1],
  ["february", 2],
  ["march", 3],
  ["april", 4],
  ["may", 5],
  ["june", 6],
  ["july", 7],
  ["august", 8],
  ["september", 9],
  ["october", 10],
  ["november", 11],
  ["december", 12],
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sept", 9],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
];
const EN_MONTH_OF = new Map(EN_MONTHS);
const EN_MONTH = monthRe(EN_MONTHS);
const ORDINAL = "(?:st|nd|rd|th)";

/** "5pm", "9:30am", "12am" (midnight), "12pm" (noon). */
const twelveHour = (h: number, m: number, half: string) =>
  h < 1 || h > 12 ? null : time((h % 12) + (half === "pm" ? 12 : 0), m);

const EN: DateWords = {
  dateRules: [
    { re: /today/y, resolve: (_m, today) => today, dayPart: true },
    { re: /tonight/y, resolve: (_m, today) => today, time: "18:00" },
    {
      re: /(?:the\s+)?day\s+after\s+tomorrow/y,
      resolve: (_m, today) => addDays(today, 2),
      dayPart: true,
    },
    {
      re: /tomorrow/y,
      resolve: (_m, today) => addDays(today, 1),
      dayPart: true,
    },
    {
      re: /in\s+(\d{1,3}|a|an|one)\s+(days?|weeks?)/y,
      resolve: (m, today) => {
        const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
        return addDays(today, m[2].startsWith("week") ? n * 7 : n);
      },
    },
    // Next Monday, like the date picker's "Next Monday" (Todoist's "next week").
    { re: /next\s+week/y, resolve: (_m, today) => nextWeekday(today, 1) },
    {
      // The next occurrence, never today; "next monday" is the same day (the Monday strictly
      // after today, like the date picker).
      re: new RegExp(`(?:next\\s+|on\\s+)?(${weekdayRe(EN_WEEKDAYS)})`, "y"),
      resolve: (m, today) => nextWeekday(today, EN_WEEKDAYS[m[1]]),
      dayPart: true,
    },
    {
      // "15 nov", "3rd november 2027", "on 2 jan".
      re: new RegExp(
        `(?:on\\s+)?(\\d{1,2})${ORDINAL}?\\s+(?:of\\s+)?(${EN_MONTH})\\.?(?:\\s+(\\d{4}))?`,
        "y",
      ),
      resolve: (m, today) =>
        dayMonth(Number(m[1]), EN_MONTH_OF.get(m[2]) ?? 0, m[3], today),
      dayPart: true,
      final: true,
    },
    {
      // "nov 15", "November 15th, 2027".
      re: new RegExp(
        `(?:on\\s+)?(${EN_MONTH})\\.?\\s+(\\d{1,2})${ORDINAL}?(?:,?\\s+(\\d{4}))?`,
        "y",
      ),
      resolve: (m, today) =>
        dayMonth(Number(m[2]), EN_MONTH_OF.get(m[1]) ?? 0, m[3], today),
      dayPart: true,
      final: true,
    },
    {
      // Day first, like the dates the app shows ("3 Nov").
      re: /(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?/y,
      resolve: (m, today) => dayMonth(Number(m[1]), Number(m[2]), m[3], today),
      dayPart: true,
      final: true,
    },
    {
      re: new RegExp(`(?:on\\s+)?the\\s+(\\d{1,2})${ORDINAL}`, "y"),
      resolve: (m, today) => dayOfMonth(Number(m[1]), today),
      dayPart: true,
    },
  ],
  dayPartRe: /\s+(morning|noon|afternoon|evening|night)/y,
  dayParts: {
    morning: "09:00",
    noon: "12:00",
    afternoon: "14:00",
    evening: "18:00",
    night: "18:00",
  },
  timeRules: [
    {
      re: /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)/y,
      resolve: (m) => twelveHour(Number(m[1]), Number(m[2] ?? "0"), m[3]),
    },
    {
      re: /(?:at\s+)?(\d{1,2}):(\d{2})/y,
      resolve: (m) => time(Number(m[1]), Number(m[2])),
    },
    { re: /(?:at\s+)?noon/y, resolve: () => "12:00" },
  ],
};

const DATE_WORDS: Record<Language, DateWords> = { fr: FR, en: EN };

/** Day and month, with the year given, else this year or the next once it is past. */
function dayMonth(
  day: number,
  month: number,
  year: string | undefined,
  today: Date,
): Date | null {
  if (year !== undefined) {
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    return makeDate(y, month, day);
  }
  const d = makeDate(today.getFullYear(), month, day);
  if (d && d >= today) return d;
  return makeDate(today.getFullYear() + 1, month, day);
}

function matchDate(
  words: DateWords,
  folded: string,
  i: number,
  today: Date,
): DateMatch | null {
  for (const rule of words.dateRules) {
    rule.re.lastIndex = i;
    const m = rule.re.exec(folded);
    if (!m) continue;
    let end = i + m[0].length;
    let at = rule.time ?? null;
    if (rule.dayPart) {
      words.dayPartRe.lastIndex = end;
      const part = words.dayPartRe.exec(folded);
      if (part && endsWord(folded, end + part[0].length)) {
        at = words.dayParts[part[1].replace(/\s+/, " ")] ?? null;
        end += part[0].length;
      }
    }
    if (!endsWord(folded, end)) continue;
    const date = rule.resolve(m, today);
    if (!date) {
      if (rule.final) return null;
      continue;
    }
    return { end, date: ymd(date), time: at };
  }
  return null;
}

function matchTime(
  words: DateWords,
  folded: string,
  i: number,
): { end: number; time: string } | null {
  for (const rule of words.timeRules) {
    rule.re.lastIndex = i;
    const m = rule.re.exec(folded);
    if (!m) continue;
    const end = i + m[0].length;
    if (!endsWord(folded, end)) continue;
    const t = rule.resolve(m);
    if (t) return { end, time: t };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projects, sections, agents
// ---------------------------------------------------------------------------

/** Longest name of `items` written at `i` (folded), ending where `ends` allows. */
function longestName<T extends { name: string }>(
  folded: string,
  i: number,
  items: T[],
  ends: (j: number) => boolean,
): T | null {
  let best: T | null = null;
  let bestLength = 0;
  for (const item of items) {
    const name = fold(item.name.trim());
    if (name.length === 0 || name.length <= bestLength) continue;
    if (folded.startsWith(name, i) && ends(i + name.length)) {
      best = item;
      bestLength = name.length;
    }
  }
  return best;
}

interface Ctx {
  text: string;
  folded: string;
  subjects: Subject[];
  /** Project whose sections `/Section` looks into. */
  slashSubject: Subject | null;
  today: Date;
  agents: boolean;
  /** Date and time words of the language. */
  words: DateWords;
}

/** Section of `subject` written after the `/` at `slash`, with where it ends. */
function sectionAfter(
  folded: string,
  slash: number,
  subject: Subject,
): { section: Section; end: number } | null {
  if (folded[slash] !== "/") return null;
  const section = longestName(folded, slash + 1, subject.sections, (j) =>
    endsWord(folded, j),
  );
  if (!section) return null;
  return { section, end: slash + 1 + fold(section.name.trim()).length };
}

function matchProject(ctx: Ctx, i: number): QuickToken | null {
  const { text, folded } = ctx;
  const nameStart = i + 1;
  const endsName = (j: number) => endsWord(folded, j) || folded[j] === "/";
  // Top-level projects first: a bare name shared with a sub-project goes to the top level.
  const ordered = [
    ...ctx.subjects.filter((s) => s.parentId === null),
    ...ctx.subjects.filter((s) => s.parentId !== null),
  ];
  let subject = longestName(folded, nameStart, ordered, endsName);
  if (subject) {
    let end = nameStart + fold(subject.name.trim()).length;
    let found = sectionAfter(folded, end, subject);
    if (!found && folded[end] === "/") {
      // `#Parent/Sous-projet`, then maybe `/Section`.
      const parentId = subject.id;
      const child = longestName(
        folded,
        end + 1,
        ctx.subjects.filter((s) => s.parentId === parentId),
        endsName,
      );
      if (child) {
        subject = child;
        end = end + 1 + fold(child.name.trim()).length;
        found = sectionAfter(folded, end, child);
      }
    }
    // Taido V2.2 bis: a group holds no task; « #Groupe » alone stays text.
    if (subject.isGroup) return null;
    const section = found?.section ?? null;
    if (found) end = found.end;
    return {
      kind: "project",
      start: i,
      end,
      text: text.slice(i, end),
      value: {
        subjectId: subject.id,
        sectionId: section?.id ?? null,
        name: subject.name,
      },
    };
  }
  // No such project: one word, without a trailing punctuation mark.
  const word = /^[^\s/]+/.exec(text.slice(nameStart))?.[0] ?? "";
  const name = word.replace(/[,.;:!?)]+$/, "");
  if (name.length === 0) return null;
  const end = nameStart + name.length;
  return {
    kind: "project",
    start: i,
    end,
    text: text.slice(i, end),
    value: { subjectId: null, sectionId: null, name },
  };
}

function matchSection(ctx: Ctx, i: number): QuickToken | null {
  const subject = ctx.slashSubject;
  if (!subject) return null;
  const section = longestName(ctx.folded, i + 1, subject.sections, (j) =>
    endsWord(ctx.folded, j),
  );
  if (!section) return null;
  const end = i + 1 + fold(section.name.trim()).length;
  return {
    kind: "section",
    start: i,
    end,
    text: ctx.text.slice(i, end),
    value: { subjectId: subject.id, sectionId: section.id, name: section.name },
  };
}

const AGENT_RE = />(claude|codex|shell)/y;
const PRIORITY_RE = /!([123])/y;

function matchAt(ctx: Ctx, i: number): QuickToken | null {
  const { text, folded } = ctx;
  const ch = folded[i];
  if (ch === "#") return matchProject(ctx, i);
  if (ch === "/") return matchSection(ctx, i);
  if (ch === "!") {
    PRIORITY_RE.lastIndex = i;
    const m = PRIORITY_RE.exec(folded);
    if (!m) return null;
    const end = i + m[0].length;
    if (!endsWord(folded, end)) return null;
    return {
      kind: "priority",
      start: i,
      end,
      text: text.slice(i, end),
      value: (5 - Number(m[1])) as Priority,
    };
  }
  if (ch === ">") {
    if (!ctx.agents) return null;
    AGENT_RE.lastIndex = i;
    const m = AGENT_RE.exec(folded);
    if (!m) return null;
    const end = i + m[0].length;
    if (!endsWord(folded, end)) return null;
    return {
      kind: "agent",
      start: i,
      end,
      text: text.slice(i, end),
      value: m[1] as LaunchKind,
    };
  }
  // Taido V2.4: `@vendredi`, `@13/10`, `@demain 10h`, `@10h` — the `@`
  // only marks a date or a time, which reads as without it.
  const at = ch === "@" ? i + 1 : i;
  const date = matchDate(ctx.words, folded, at, ctx.today);
  if (date) {
    return {
      kind: "date",
      start: i,
      end: date.end,
      text: text.slice(i, date.end),
      value: { date: date.date, time: date.time },
    };
  }
  const t = matchTime(ctx.words, folded, at);
  if (t) {
    return {
      kind: "time",
      start: i,
      end: t.end,
      text: text.slice(i, t.end),
      value: { time: t.time },
    };
  }
  return null;
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

/** Every candidate token, in text order (several of a kind possible). */
function scan(ctx: Ctx, literals: Range[]): QuickToken[] {
  const tokens: QuickToken[] = [];
  let i = 0;
  while (i < ctx.text.length) {
    if (!startsWord(ctx.text, i) || isSpace(ctx.text[i])) {
      i++;
      continue;
    }
    const token = matchAt(ctx, i);
    if (token && !literals.some((r) => overlaps(r, token))) {
      tokens.push(token);
      i = token.end;
    } else {
      i++;
    }
  }
  return tokens;
}

/** The first token of each kind; known projects beat unknown ones. */
function effective(tokens: QuickToken[]): QuickToken[] {
  const project =
    tokens.find((t) => t.kind === "project" && t.value.subjectId !== null) ??
    tokens.find((t) => t.kind === "project");
  const projectHasSection =
    project?.kind === "project" && project.value.sectionId !== null;
  const section = projectHasSection
    ? undefined
    : tokens.find((t) => t.kind === "section");
  const pick = (kind: TokenKind) => tokens.find((t) => t.kind === kind);
  return [
    project,
    section,
    pick("date"),
    pick("time"),
    pick("agent"),
    pick("priority"),
  ]
    .filter((t): t is QuickToken => t !== undefined)
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseQuickAdd(
  text: string,
  now: Date,
  subjects: Subject[],
  options: ParseOptions = {},
): ParseResult {
  const literals = options.literals ?? [];
  const contextSubject =
    subjects.find((s) => s.id === options.contextSubjectId) ?? null;
  const ctx: Ctx = {
    text,
    folded: fold(text),
    subjects,
    slashSubject: contextSubject,
    today: startOfDay(now),
    agents: options.agents ?? true,
    words: DATE_WORDS[options.language ?? activeLanguage],
  };

  let tokens = effective(scan(ctx, literals));
  // `/Section` belongs to the project named in the text, when there is one.
  const named = tokens.find((t) => t.kind === "project");
  if (named?.kind === "project") {
    const subject =
      subjects.find((s) => s.id === named.value.subjectId) ?? null;
    if (subject !== ctx.slashSubject) {
      ctx.slashSubject = subject;
      tokens = effective(scan(ctx, literals));
    }
  }

  const result: ParseResult = {
    title: "",
    tokens,
    slashSubject: ctx.slashSubject,
  };
  const removed: Range[] = [];
  let dateValue: string | undefined;
  let impliedTime: string | null = null;
  let explicitTime: string | undefined;

  for (const token of tokens) {
    switch (token.kind) {
      case "project": {
        const subject = subjects.find((s) => s.id === token.value.subjectId);
        if (!subject) {
          result.unknownProject = token.value.name;
          continue; // stays in the title until the project exists
        }
        result.subject = subject;
        const section = subject.sections.find(
          (s) => s.id === token.value.sectionId,
        );
        if (section) result.section = section;
        break;
      }
      case "section": {
        const subject = subjects.find((s) => s.id === token.value.subjectId);
        if (subject) {
          result.subject ??= subject;
          result.section = subject.sections.find(
            (s) => s.id === token.value.sectionId,
          );
        }
        break;
      }
      case "agent":
        result.launch = token.value;
        break;
      case "priority":
        result.priority = token.value;
        break;
      case "date":
        dateValue = token.value.date;
        impliedTime = token.value.time;
        break;
      case "time":
        explicitTime = token.value.time;
        break;
    }
    removed.push(token);
  }

  const at = explicitTime ?? impliedTime ?? undefined;
  if (dateValue !== undefined) {
    result.due = at ? { date: dateValue, time: at } : { date: dateValue };
  } else if (at !== undefined) {
    // A time alone is for today, even when already past (like the date picker).
    result.due = { date: ymd(ctx.today), time: at };
  }

  let title = "";
  let cursor = 0;
  for (const r of removed) {
    // « Payer #Perso, vite » → « Payer, vite »: no space before a comma or a period.
    const seam = /^[,.]/.test(text.slice(r.end)) ? "" : " ";
    title += `${text.slice(cursor, r.start).trimEnd()}${seam}`;
    cursor = r.end;
  }
  title += text.slice(cursor);
  result.title = title.replace(/\s+/g, " ").trim();
  return result;
}

/**
 * Moves ranges after an edit of the text (`before` → `after`): ranges before the edited part
 * stay, ranges after it shift, ranges it touches are dropped (their token was edited).
 */
export function shiftRanges(
  before: string,
  after: string,
  ranges: Range[],
): Range[] {
  if (ranges.length === 0 || before === after) return ranges;
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const editEnd = before.length - suffix;
  const delta = after.length - before.length;
  return ranges.flatMap((r) => {
    if (r.end <= prefix) return [r];
    if (r.start >= editEnd)
      return [{ start: r.start + delta, end: r.end + delta }];
    return [];
  });
}

/**
 * Literal ranges after which no token of `kinds` is recognised any more (a removed chip, or a
 * value picked by hand): the tokens in use, then the ones they hid (« demain … lundi »).
 * Unknown projects are left alone: they never set the destination.
 */
export function literalsWithout(
  text: string,
  now: Date,
  subjects: Subject[],
  options: ParseOptions,
  kinds: TokenKind[],
): Range[] {
  const literals = [...(options.literals ?? [])];
  // Each round removes at least one token, and a text holds far fewer than this.
  for (let round = 0; round < 100; round++) {
    const { tokens } = parseQuickAdd(text, now, subjects, {
      ...options,
      literals,
    });
    const found = tokens.filter(
      (t) =>
        kinds.includes(t.kind) &&
        !(t.kind === "project" && t.value.subjectId === null),
    );
    if (found.length === 0) break;
    literals.push(...found.map((t) => ({ start: t.start, end: t.end })));
  }
  return literals;
}
