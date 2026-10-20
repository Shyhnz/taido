/**
 * Autocompletion of `#projet` and `/section` in the quick add: fuzzy, without
 * case or accents. Pure: the dialog gives the text, the caret and the projects. `@` offers dates the same way, in the interface's language; choosing one writes
 * the plain date word (« vendredi », "friday"), which the parser reads with or without the `@`.
 */

import type { Subject, SubjectColor } from "../../bindings";
import { activeLanguage, type Language } from "../../i18n";
import { formatDueMeta } from "../../lib/dates";
import { projectPath, sectionPath } from "../../lib/format";
import { fold, parseQuickAdd } from "./parse";

export interface CompletionOption {
  /** « Site », « Site › Design », « Globex › Admin » for a sub-project. */
  label: string;
  /**
   * Text that replaces the fragment: « #Site », « #Site/Design », « /Design », « #Globex/Admin »
   * for a sub-project whose name another project shares.
   */
  insert: string;
  color: SubjectColor;
  /** A date option (a calendar icon instead of the project dot). */
  date?: boolean;
  /** Muted text after the label: the date a date word gives (« ven. 16 oct. »). */
  hint?: string;
  /**
   * The fragment starts the name or one of its words (« #si » → « Site », « #dup » → « Client
   * Dupont »): Entrée may take it as is. A looser match (« /tmp » → « Templates ») is only
   * taken by Entrée once chosen with ↑/↓, or by Tab; otherwise Entrée adds the task.
   */
  strong: boolean;
}

export interface Completion {
  /** Index of the `#` or `/` being completed. */
  start: number;
  /** End of the fragment (the caret). */
  end: number;
  options: CompletionOption[];
}

const MAX_OPTIONS = 8;
/** How far back from the caret a `#` or `/` is looked for. */
const LOOK_BACK = 60;

/**
 * Rank of `name` for `query` (both folded): prefix, start of a word, anywhere, then letters in
 * order; `null` when it does not match.
 */
export function fuzzyRank(name: string, query: string): number | null {
  if (query.length === 0) return 0;
  if (name.startsWith(query)) return 0;
  const at = name.indexOf(query);
  if (at > 0 && /[\s\-_/›]/.test(name[at - 1])) return 1;
  if (at > 0) return 2;
  let i = 0;
  for (const ch of name) {
    if (ch === query[i]) i++;
    if (i === query.length) return 3;
  }
  return null;
}

type Candidate = Omit<CompletionOption, "strong">;

/**
 * What follows `#` to name `subject`: its name, or `Parent/Name` for a
 * sub-project whose name another project shares, which the parser reads unambiguously.
 */
function projectRef(subject: Subject, subjects: Subject[]): string {
  const parent = subject.parentId
    ? subjects.find((s) => s.id === subject.parentId)
    : undefined;
  if (!parent) return subject.name;
  const name = fold(subject.name.trim());
  const shared = subjects.some(
    (s) => s.id !== subject.id && fold(s.name.trim()) === name,
  );
  return shared ? `${parent.name}/${subject.name}` : subject.name;
}

/** Every way `#` may name `subject`: its name, and `Parent/Name` for a sub-project. */
function projectRefs(subject: Subject, subjects: Subject[]): string[] {
  const parent = subjects.find((s) => s.id === subject.parentId);
  return parent
    ? [subject.name, `${parent.name}/${subject.name}`]
    : [subject.name];
}

/** Project options: labelled with the parent, ranked on the name itself. */
function projectOptions(
  list: Subject[],
  subjects: Subject[],
  insert: (s: Subject) => string,
  query: string,
  prefixOnly: boolean,
): CompletionOption[] {
  const names = new Map<Candidate, string>();
  const candidates = list.map((s) => {
    const option = {
      label: projectPath(s, subjects),
      insert: insert(s),
      color: s.color,
    };
    names.set(option, s.name);
    return option;
  });
  return ranked(candidates, (o) => names.get(o) ?? o.label, query, prefixOnly);
}

/** Section options of `subject`, inserted after `#${ref}/`. */
function sectionOptions(
  subject: Subject,
  subjects: Subject[],
  ref: string,
): Candidate[] {
  return subject.sections.map((sec) => ({
    label: sectionPath(subject, sec, subjects),
    insert: `#${ref}/${sec.name}`,
    color: subject.color,
  }));
}

function ranked(
  candidates: Candidate[],
  key: (o: Candidate) => string,
  query: string,
  prefixOnly: boolean,
): CompletionOption[] {
  const scored: { option: Candidate; rank: number; index: number }[] = [];
  candidates.forEach((option, index) => {
    const name = fold(key(option));
    const rank = prefixOnly
      ? name.startsWith(query)
        ? 0
        : null
      : fuzzyRank(name, query);
    if (rank !== null) scored.push({ option, rank, index });
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((s) => ({ ...s.option, strong: s.rank <= 1 }))
    .slice(0, MAX_OPTIONS);
}

/** What `@` offers: the date words the parser knows, with the date each gives today. */
const DATE_WORDS: Record<Language, string[]> = {
  fr: [
    "aujourd'hui",
    "demain",
    "après-demain",
    "ce soir",
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
    "dimanche",
    "dans 1 semaine",
  ],
  en: [
    "today",
    "tomorrow",
    "tonight",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "next week",
    "in 1 week",
  ],
};

function dateCandidates(now: Date): Candidate[] {
  return DATE_WORDS[activeLanguage].flatMap((word) => {
    const due = parseQuickAdd(word, now, [], { language: activeLanguage }).due;
    if (!due) return [];
    return [
      {
        label: word.charAt(0).toUpperCase() + word.slice(1),
        insert: word,
        color: "gray" as SubjectColor,
        date: true,
        hint: formatDueMeta({ date: due.date, time: due.time ?? null }, now),
      },
    ];
  });
}

/** Name of the section of a « Projet › Section » option (what the query is matched on). */
function sectionName(o: Candidate): string {
  const at = o.label.lastIndexOf(" › ");
  return at === -1 ? o.label : o.label.slice(at + 3);
}

/** The `#` or `/` that starts the fragment ending at the caret, if any. */
function symbolBefore(text: string, caret: number): number | null {
  for (let k = caret - 1; k >= Math.max(0, caret - LOOK_BACK); k--) {
    const ch = text[k];
    if (
      (ch === "#" || ch === "/" || ch === "@") &&
      (k === 0 || /\s/.test(text[k - 1]))
    ) {
      return k;
    }
  }
  return null;
}

/**
 * Options for the fragment at the caret. `slashSubject`: project whose sections `/` offers
 * (the parser's: named in the text, else the current view's). `null` when there is nothing to
 * offer, when the only option is exactly what is already typed, or once a complete name is
 * followed by a space (« #Site » then a space does not offer « Site web » any more).
 */
export function findCompletion(
  text: string,
  caret: number,
  subjects: Subject[],
  slashSubject: Subject | null,
  now: Date = new Date(),
): Completion | null {
  const start = symbolBefore(text, caret);
  if (start === null) return null;
  const fragment = text.slice(start + 1, caret);
  if (text[start] === "@") {
    // A date word is one or two words: stop offering after a space.
    if (/\s/.test(fragment)) return null;
    const options = ranked(
      dateCandidates(now),
      (o) => o.label,
      fold(fragment),
      false,
    );
    return options.length > 0 ? { start, end: caret, options } : null;
  }
  // Several words are only completed while they start an existing name (« Client Du »).
  const prefixOnly = /\s/.test(fragment);
  const query = fold(fragment);
  const typed = fold(text.slice(start, caret));
  if (/\s$/.test(fragment)) {
    const complete = typed.trimEnd();
    const names =
      text[start] === "#"
        ? subjects.flatMap((s) =>
            projectRefs(s, subjects).flatMap((ref) => [
              `#${ref}`,
              ...s.sections.map((sec) => `#${ref}/${sec.name}`),
            ]),
          )
        : (slashSubject?.sections.map((sec) => `/${sec.name}`) ?? []);
    if (names.some((n) => fold(n.trim()) === complete)) return null;
  }
  let options: CompletionOption[];

  if (text[start] === "#") {
    const parts = query.split("/");
    if (parts.length > 1) {
      // « #Site/De »: the sections of that project, and its sub-projects (« #Globex/Ad »);
      // « #Globex/Admin/De »: the sections of that sub-project. Top-level projects first, as
      // in the parser.
      const ordered = [
        ...subjects.filter((s) => s.parentId === null),
        ...subjects.filter((s) => s.parentId !== null),
      ];
      const parent = ordered.find((s) => fold(s.name) === parts[0]);
      if (!parent) return null;
      const children = subjects.filter((s) => s.parentId === parent.id);
      const rest = parts.slice(1).join("/");
      if (parts.length > 2) {
        const child = children.find((s) => fold(s.name) === parts[1]);
        if (!child) return null;
        const ref = `${parent.name}/${child.name}`;
        options = ranked(
          sectionOptions(child, subjects, ref),
          sectionName,
          parts.slice(2).join("/"),
          prefixOnly,
        );
      } else {
        options = [
          ...ranked(
            sectionOptions(parent, subjects, parent.name),
            sectionName,
            rest,
            prefixOnly,
          ),
          ...projectOptions(
            children,
            subjects,
            (s) => `#${parent.name}/${s.name}`,
            rest,
            prefixOnly,
          ),
        ].slice(0, MAX_OPTIONS);
      }
    } else {
      const projects = projectOptions(
        // A group holds no task.
        subjects.filter((s) => !s.isGroup),
        subjects,
        (s) => `#${projectRef(s, subjects)}`,
        query,
        prefixOnly,
      );
      // Sections too, once something is typed (« #des » finds « Site › Design »).
      const sections =
        query.length === 0
          ? []
          : subjects.flatMap((s) =>
              sectionOptions(s, subjects, projectRef(s, subjects)),
            );
      options = [
        ...projects,
        ...ranked(sections, sectionName, query, prefixOnly),
      ].slice(0, MAX_OPTIONS);
    }
  } else {
    if (!slashSubject) return null;
    const sections = slashSubject.sections.map((sec) => ({
      label: sec.name,
      insert: `/${sec.name}`,
      color: slashSubject.color,
    }));
    options = ranked(sections, (o) => o.label, query, prefixOnly);
  }

  if (options.length === 0) return null;
  if (options.length === 1 && fold(options[0].insert) === typed) return null;
  return { start, end: caret, options };
}

/**
 * Text after choosing `option`: the fragment is replaced and followed by a space. Returns the
 * new text and the caret position.
 */
export function applyCompletion(
  text: string,
  completion: Completion,
  option: CompletionOption,
): { text: string; caret: number } {
  // The rest of the word under the caret goes too (« #Si|te » → « #Site »).
  const rest = /^\S*/.exec(text.slice(completion.end))?.[0].length ?? 0;
  const after = text.slice(completion.end + rest);
  const space = after.startsWith(" ") ? "" : " ";
  const next = `${text.slice(0, completion.start)}${option.insert}${space}${after}`;
  return { text: next, caret: completion.start + option.insert.length + 1 };
}
