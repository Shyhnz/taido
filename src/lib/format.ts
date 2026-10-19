import type { Subject, SubjectColor } from "../bindings";
import { fr } from "../i18n/fr";

/** Truncates `text` to at most `max` characters, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Shortens a home folder to `~` for display: `/Users/user/x` → `~/x`. */
export function shortenPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** CSS color of a subject (palette tokens adapt to the theme). */
export function subjectColorVar(color: SubjectColor): string {
  return `var(--subject-${color})`;
}

/** The 8 subject colors in palette order. */
export const SUBJECT_COLORS: SubjectColor[] = [
  "violet",
  "teal",
  "pink",
  "gray",
  "blue",
  "indigo",
  "brown",
  "slate",
];

/**
 * Display name of a project: « Globex › Client » for a sub-project. Every
 * project picker uses it, so two sub-projects with the same name stay distinct.
 */
export function projectPath(
  subject: Pick<Subject, "name" | "parentId">,
  subjects: Pick<Subject, "id" | "name">[],
): string {
  const parent = subject.parentId
    ? subjects.find((s) => s.id === subject.parentId)
    : undefined;
  return parent ? fr.subProjects.path(parent.name, subject.name) : subject.name;
}

/** `projectPath` followed by a section: « Globex › Client › Design ». */
export function sectionPath(
  subject: Pick<Subject, "name" | "parentId">,
  section: { name: string },
  subjects: Pick<Subject, "id" | "name">[],
): string {
  return fr.subProjects.path(projectPath(subject, subjects), section.name);
}
