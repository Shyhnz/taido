/**
 * « Historique »: the task journal, collapsed by default at the bottom of the panel
 * in `--text-3`. Expanded: most recent first, with a date column. Read-only (2026-10-03).
 */

import type { JournalEntry, JournalKind } from "../../bindings";
import { t } from "../../i18n";
import { formatJournalDate } from "../../lib/dates";
import { useJournal } from "../../lib/queries";
import { Fold } from "./PanelFold";

/**
 * Kinds shown in the task « Historique »: the life of the task itself. What happens in a
 * Claude conversation lives in « Sessions Claude ».
 */
const TASK_KINDS: ReadonlySet<JournalKind> = new Set([
  "created",
  "completed",
  "reopened",
  "note",
]);

/** Entries of the task « Historique » (task-level kinds only). */
export function taskEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => TASK_KINDS.has(e.kind));
}

/** Text of an entry: the core leaves `created`, `completed`, `reopened` empty. */
export function journalText(entry: JournalEntry): string {
  if (entry.text.trim().length > 0) return entry.text;
  return t.journal[entry.kind];
}

function JournalList({ taskId }: { taskId: string }) {
  const { data } = useJournal(taskId);
  const entries = taskEntries(data ?? []);
  return (
    <div className="pt-1">
      {entries.length === 0 ? (
        <p className="py-2 text-[13px] text-text-3">{t.panel.emptyJournal}</p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-kind={entry.kind}
              className="flex gap-3 py-1.5"
            >
              <time
                dateTime={entry.at}
                title={new Date(entry.at).toLocaleString("fr-FR")}
                className="w-[108px] shrink-0 pt-px text-[12px] text-text-3"
              >
                {formatJournalDate(entry.at)}
              </time>
              <span
                className={`min-w-0 flex-1 text-[13px] whitespace-pre-wrap ${
                  entry.kind === "note" ? "text-text-2" : "text-text-3"
                }`}
              >
                {journalText(entry)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Journal({ taskId }: { taskId: string }) {
  const { data } = useJournal(taskId);
  const count = taskEntries(data ?? []).length;
  return (
    <Fold
      id="journal"
      title={t.panel.journal}
      summary={count > 0 && t.folds.journalCount(count)}
    >
      <JournalList taskId={taskId} />
    </Fold>
  );
}
