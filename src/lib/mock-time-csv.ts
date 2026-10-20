/**
 * « Exporter les temps (CSV) » of the mock backend, hence of the web app, like the core's
 * `views::portfolio::time_csv`: one line per segment started in the period, every project
 * (and the Inbox), in the user's language: `;` in French and `,` otherwise, with a UTF-8 BOM
 * so that Excel opens it in the user's own settings. The web app saves it with `saveBlob`
 * (src/lib/web-files.ts).
 */

import type { ChronoStop, Language } from "../bindings";
import type { SegmentRec } from "./mock-chrono";

export interface CsvTask {
  title: string;
  /** The project's name, `null` for the Inbox. */
  project: string | null;
}

/** The core's labels (`i18n::export`), by language. */
const TEXTS: Record<
  Language,
  {
    separator: string;
    header: string[];
    noProject: string;
    running: string;
    byHand: string;
    reasons: Record<ChronoStop, string>;
  }
> = {
  en: {
    separator: ",",
    header: [
      "Project",
      "Task",
      "Start",
      "End",
      "Duration",
      "Duration (min)",
      "Source",
      "Stop reason",
      "Note",
    ],
    noProject: "Inbox",
    running: "running",
    byHand: "by hand",
    reasons: {
      waiting: "waiting for you",
      turn_ended: "Claude is done",
      session_closed: "session closed",
      task_done: "task completed",
      app_closed: "Taido closed",
    },
  },
  fr: {
    separator: ";",
    header: [
      "Projet",
      "Tâche",
      "Début",
      "Fin",
      "Durée",
      "Durée (min)",
      "Source",
      "Raison d'arrêt",
      "Note",
    ],
    noProject: "Sans projet",
    running: "en cours",
    byHand: "à la main",
    reasons: {
      waiting: "attend ta réponse",
      turn_ended: "Claude a fini",
      session_closed: "session fermée",
      task_done: "tâche terminée",
      app_closed: "Taido fermé",
    },
  },
};

function field(value: string, separator: string): string {
  return value.includes(separator) || /["\n\r]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM`, local time (the core's `%Y-%m-%d %H:%M`). */
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timeCsv(
  segments: readonly SegmentRec[],
  taskOf: (taskId: string) => CsvTask | null,
  days: number,
  now: Date,
  lang: Language,
): string {
  const text = TEXTS[lang];
  const sep = text.separator;
  const span = Math.min(366, Math.max(1, Math.trunc(days)));
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (span - 1),
  ).getTime();
  const rows = segments
    .filter((s) => s.deletedAt === null)
    .slice()
    .sort((a, b) =>
      a.startedAt === b.startedAt
        ? a.id.localeCompare(b.id)
        : a.startedAt < b.startedAt
          ? -1
          : 1,
    );
  let out = `\u{feff}${text.header.join(sep)}\r\n`;
  for (const s of rows) {
    const task = taskOf(s.taskId);
    const start = Date.parse(s.startedAt);
    if (!task || Number.isNaN(start)) continue;
    if (start < from || start > now.getTime()) continue;
    const end = s.endedAt === null ? Number.NaN : Date.parse(s.endedAt);
    const ended = !Number.isNaN(end);
    const secs = Math.max(
      0,
      Math.floor(((ended ? end : now.getTime()) - start) / 1000),
    );
    const duration = `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
    out += [
      field(task.project ?? text.noProject, sep),
      field(task.title, sep),
      stamp(new Date(start)),
      ended ? stamp(new Date(end)) : text.running,
      duration,
      String(Math.floor((secs + 30) / 60)),
      s.source === "manual" ? text.byHand : "Claude",
      s.stopReason ? text.reasons[s.stopReason] : "",
      field(s.note, sep),
    ].join(sep);
    out += "\r\n";
  }
  return out;
}
