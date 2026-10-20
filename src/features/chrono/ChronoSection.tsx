/**
 * « Chrono » in the task panel: the big counter, why it is
 * paused, its journal (most recent first) and « + Ajouter du temps à la main » for the tasks
 * done without Claude (a call, an invoice). No play button: the sessions drive it; a running
 * segment only has « Arrêter », for a timer stuck on a lost Mac (docs/SYNC.md § 0.8).
 */

import { X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { Agent, TaskDetail, TimeSegment } from "../../bindings";
import { Button } from "../../components/Button";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { formatSessionStart } from "../../lib/dates";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { Fold } from "../task-panel/PanelFold";
import {
  chronoSeconds,
  formatChrono,
  formatDuration,
  formatHours,
  useNow,
} from "./chrono";

/** What a journal line says happened. */
export function segmentEvent(
  segment: TimeSegment,
  agent: Agent = "claude",
): string {
  if (segment.source === "manual") {
    return segment.note
      ? `${t.chrono.event.manual} (${segment.note})`
      : t.chrono.event.manual;
  }
  if (segment.endedAt === null) return t.chrono.event.running;
  // No reason: stopped with « Arrêter » (every automatic stop records one).
  if (segment.stopReason === "turn_ended")
    return t.chrono.eventTurnEnded(agent);
  return segment.stopReason
    ? t.chrono.event[segment.stopReason]
    : t.chrono.event.stoppedByHand;
}

/** « Arrêter »: stops a running segment, this device's or another one's (docs/SYNC.md § 0.8). */
async function stopSegment(id: string) {
  if (await run(commands.stopTimeSegment(id))) {
    showToast({ message: t.chrono.stopped });
  }
}

function SegmentLine({ segment }: { segment: TimeSegment }) {
  const agent = useDefaultAgent();
  // An automatic segment is listed at its stop, a running or manual one at its start.
  const at =
    segment.source === "auto" && segment.endedAt
      ? segment.endedAt
      : segment.startedAt;
  return (
    <li
      className="group/segment flex items-center gap-3 py-1 text-[13px]"
      data-segment={segment.id}
    >
      <time
        dateTime={at}
        className="w-[108px] shrink-0 text-[12px] text-text-3"
      >
        {formatSessionStart(at)}
      </time>
      <span
        title={segmentEvent(segment, agent)}
        className="min-w-0 flex-1 truncate text-text-2"
      >
        {segmentEvent(segment, agent)}
      </span>
      <span className="shrink-0 tabular-nums text-text-2">
        {segment.endedAt ? formatDuration(segment.seconds) : ""}
      </span>
      {segment.endedAt === null && (
        <button
          type="button"
          onClick={() => void stopSegment(segment.id)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12.5px] text-text-2 hover:bg-hover hover:text-text"
        >
          {t.chrono.stop}
        </button>
      )}
      {segment.endedAt && (
        <button
          type="button"
          aria-label={t.chrono.deleteSegment}
          title={t.chrono.deleteSegment}
          onClick={() => void run(commands.deleteTimeSegment(segment.id))}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 opacity-0 hover:bg-hover hover:text-text group-hover/segment:opacity-100 focus-visible:opacity-100"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </li>
  );
}

function ManualForm({
  taskId,
  onDone,
}: {
  taskId: string;
  onDone: () => void;
}) {
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState(false);
  const minutesId = useId();
  const noteId = useId();
  const minutesRef = useRef<HTMLInputElement>(null);
  // The form opens on a click: its first field takes the focus.
  useEffect(() => minutesRef.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 1 || value > 1440) {
      setInvalid(true);
      return;
    }
    const done = await run(
      commands.addManualTime({ taskId, minutes: value, note }),
    );
    if (done) onDone();
  };

  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label
          htmlFor={minutesId}
          className="flex flex-col gap-1 text-[12px] text-text-2"
        >
          {t.chrono.manualMinutes}
          <input
            id={minutesId}
            ref={minutesRef}
            inputMode="numeric"
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              setInvalid(false);
            }}
            aria-invalid={invalid || undefined}
            className="h-8 w-24 rounded-md border border-border bg-bg px-2 text-[13.5px] text-text"
          />
        </label>
        <label
          htmlFor={noteId}
          className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] text-text-2"
        >
          {t.chrono.manualNote}
          <input
            id={noteId}
            value={note}
            placeholder={t.chrono.manualNotePlaceholder}
            onChange={(e) => setNote(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-[13.5px] text-text"
          />
        </label>
      </div>
      {invalid && (
        <p role="alert" className="text-[12px] text-due-overdue">
          {t.chrono.manualInvalid}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm">
          {t.chrono.manualAdd}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t.chrono.manualCancel}
        </Button>
      </div>
    </form>
  );
}

/** Journal lines shown before « Voir tout le journal » (layout C, 2026-10-11). */
export const SEGMENTS_SHOWN = 5;

export function ChronoSection({
  task,
  startAdding = false,
}: {
  task: TaskDetail;
  /** Opened from « Ajouter : Temps »: the hand-entry form shows right away. */
  startAdding?: boolean;
}) {
  const { chrono, segments } = task.time;
  const agent = useDefaultAgent();
  const running = chrono.runningSince !== null;
  const now = useNow(running);
  const [adding, setAdding] = useState(startAdding);
  const [allSegments, setAllSegments] = useState(false);
  const shown = allSegments ? segments : segments.slice(0, SEGMENTS_SHOWN);
  const lastAuto = segments.find((s) => s.source === "auto" && s.endedAt);
  const status = running
    ? t.chrono.running(agent)
    : segments.length === 0
      ? t.chrono.never(agent)
      : lastAuto?.stopReason
        ? t.chrono.paused(lastAuto.stopReason, agent)
        : lastAuto
          ? t.chrono.pausedByHand(agent)
          : null;

  const seconds = chronoSeconds(chrono, now);
  return (
    <Fold
      id="chrono"
      title={t.chrono.title}
      summary={
        segments.length > 0 && (
          <span>
            {formatHours(seconds)} ·{" "}
            {running ? t.folds.chronoRunning : t.folds.chronoPaused}
          </span>
        )
      }
    >
      <div data-chrono-section>
        {segments.length > 0 && (
          <p
            className="text-[28px] leading-9 font-medium tabular-nums text-text"
            data-chrono={running ? "running" : "paused"}
          >
            {formatChrono(seconds)}
          </p>
        )}
        {status && (
          <p className={`text-[13px] ${running ? "text-text" : "text-text-2"}`}>
            {status}
          </p>
        )}
        {segments.length > 0 && (
          <div className="mt-3">
            <h3 className="text-[12px] text-text-3">{t.chrono.journal}</h3>
            <ol className="flex flex-col">
              {shown.map((s) => (
                <SegmentLine key={s.id} segment={s} />
              ))}
            </ol>
            {segments.length > SEGMENTS_SHOWN && (
              <button
                type="button"
                aria-expanded={allSegments}
                onClick={() => setAllSegments((a) => !a)}
                className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] text-text-2 hover:bg-hover hover:text-text"
              >
                {allSegments
                  ? t.folds.showFewerSegments
                  : t.folds.showAllSegments(segments.length)}
              </button>
            )}
          </div>
        )}
        {adding ? (
          <ManualForm taskId={task.id} onDone={() => setAdding(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="-ml-1 mt-1.5 rounded-md px-1 py-1 text-[13px] text-text-2 hover:bg-hover hover:text-text"
          >
            {t.chrono.addManual}
          </button>
        )}
      </div>
    </Fold>
  );
}
