/**
 * « Exporter les temps (CSV) » of the mock backend, hence of the web app (Taido V2.8), like the
 * core's `views::portfolio::time_csv`: one line per segment started in the period, every
 * project (and « Sans projet »), `;`-separated with a UTF-8 BOM so that Excel opens it in
 * French. The web app saves it with `saveBlob` (src/lib/web-files.ts).
 */

import type { ChronoStop } from "../bindings";
import type { SegmentRec } from "./mock-chrono";

export interface CsvTask {
  title: string;
  /** The project's name, `null` for « Sans projet ». */
  project: string | null;
}

const HEADER =
  "\u{feff}Projet;Tâche;Début;Fin;Durée;Durée (min);Source;Raison d'arrêt;Note\r\n";

const REASONS: Record<ChronoStop, string> = {
  waiting: "attend ta réponse",
  turn_ended: "Claude a fini",
  session_closed: "session fermée",
  task_done: "tâche terminée",
  app_closed: "Taido fermé",
};

function field(value: string): string {
  return /[;"\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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
): string {
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
  let out = HEADER;
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
      field(task.project ?? "Sans projet"),
      field(task.title),
      stamp(new Date(start)),
      ended ? stamp(new Date(end)) : "en cours",
      duration,
      String(Math.floor((secs + 30) / 60)),
      s.source === "manual" ? "à la main" : "Claude",
      s.stopReason ? REASONS[s.stopReason] : "",
      field(s.note),
    ].join(";");
    out += "\r\n";
  }
  return out;
}
