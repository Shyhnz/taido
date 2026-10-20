/**
 * The chrono of the mock backend, following the core's `db::time_segments`:
 * a task's automatic segment runs while one of its own Claude sessions works (or waits for
 * the answer when `chronoCountsWaiting` is on) and the task is open; manual segments are
 * stopped from the start.
 *
 * (docs/SYNC.md § 0.8): a running segment is this device's only when it has a
 * session here (`agentSessionId`); one pulled from a Mac never has one, so `reconcile` never
 * stops nor touches it. The views count every running segment up to now. Only « Arrêter »
 * (`stop`, a click) stops any running segment.
 */

import type {
  ChronoStop,
  SessionState,
  TaskChrono,
  TaskTime,
  TimeSegment,
} from "../bindings";

export interface SegmentRec {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  source: "auto" | "manual";
  startedAt: string;
  endedAt: string | null;
  stopReason: ChronoStop | null;
  note: string;
  /** Synced (`TimeSegmentData.created_at`). Optional: absent in a set saved by an older build. */
  createdAt?: string;
  deletedAt: string | null;
}

/** What `reconcile` needs to know about the task and its own sessions. */
export interface ChronoFacts {
  taskOpen: boolean;
  /** The task's own sessions, most recent state change first. */
  sessions: { id: string; state: SessionState }[];
  countsWaiting: boolean;
}

/** Longest manual entry, like the core: one day. */
export const MAX_MANUAL_MINUTES = 24 * 60;

const LIVE = (s: SessionState) => s !== "paused" && s !== "crashed";

function secondsBetween(start: string, end: string): number {
  return Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
}

export class MockChrono {
  segments: SegmentRec[] = [];

  constructor(private readonly newId: () => string) {}

  reset(): void {
    this.segments = [];
  }

  private live(taskId: string): SegmentRec[] {
    return this.segments.filter(
      (s) => s.taskId === taskId && s.deletedAt === null,
    );
  }

  /** The task's running segment of this device (one of its sessions), never a pulled one. */
  private running(taskId: string): SegmentRec | undefined {
    return this.live(taskId).find(
      (s) => s.endedAt === null && s.agentSessionId !== null,
    );
  }

  /** Opens or closes the task's automatic segment; returns whether one changed. */
  reconcile(taskId: string, facts: ChronoFacts, now: string): boolean {
    const counts = (s: SessionState) =>
      s === "working" || (facts.countsWaiting && s === "waiting");
    const runningSession = facts.taskOpen
      ? facts.sessions.find((s) => counts(s.state))
      : undefined;
    const open = this.running(taskId);
    if (!open && runningSession) {
      this.segments.push({
        id: this.newId(),
        taskId,
        agentSessionId: runningSession.id,
        source: "auto",
        startedAt: now,
        endedAt: null,
        stopReason: null,
        note: "",
        createdAt: now,
        deletedAt: null,
      });
      return true;
    }
    if (open && !runningSession) {
      open.endedAt = now < open.startedAt ? open.startedAt : now;
      open.stopReason = !facts.taskOpen
        ? "task_done"
        : facts.sessions.some((s) => s.state === "waiting")
          ? "waiting"
          : facts.sessions.some((s) => LIVE(s.state))
            ? "turn_ended"
            : "session_closed";
      return true;
    }
    return false;
  }

  /** Ids of the tasks with a running segment of this device. */
  runningTaskIds(): string[] {
    return this.segments
      .filter(
        (s) =>
          s.endedAt === null &&
          s.deletedAt === null &&
          s.agentSessionId !== null,
      )
      .map((s) => s.taskId);
  }

  addManual(taskId: string, minutes: number, note: string, now: string): void {
    const start = new Date(Date.parse(now) - minutes * 60_000).toISOString();
    this.segments.push({
      id: this.newId(),
      taskId,
      agentSessionId: null,
      source: "manual",
      startedAt: start,
      endedAt: now,
      stopReason: null,
      note: note.trim(),
      createdAt: now,
      deletedAt: null,
    });
  }

  /** Removes for good the segments of these tasks (purge, `ON DELETE CASCADE`). */
  dropTasks(taskIds: ReadonlySet<string>): void {
    this.segments = this.segments.filter((s) => !taskIds.has(s.taskId));
  }

  /**
   * « Arrêter » (docs/SYNC.md § 0.8): stops any running segment by hand, this device's or one
   * pulled from a Mac, at `now` (never before its start) with no reason; a stopped one is left
   * as is. Returns it (`undefined`: unknown).
   */
  stop(id: string, now: string): SegmentRec | undefined {
    const s = this.segments.find((x) => x.id === id && x.deletedAt === null);
    if (!s) return undefined;
    if (s.endedAt === null) {
      s.endedAt = now < s.startedAt ? s.startedAt : now;
      s.stopReason = null;
    }
    return s;
  }

  /** Soft-deletes a stopped segment; returns it (`undefined`: unknown or running). */
  delete(id: string, now: string): SegmentRec | undefined {
    const s = this.segments.find((x) => x.id === id && x.deletedAt === null);
    if (!s || s.endedAt === null) return undefined;
    s.deletedAt = now;
    return s;
  }

  /** A row's chrono, `null` without any segment. */
  chronoOf(taskId: string): TaskChrono | null {
    const live = this.live(taskId);
    if (live.length === 0) return null;
    return {
      seconds: live.reduce(
        (sum, s) =>
          sum + (s.endedAt ? secondsBetween(s.startedAt, s.endedAt) : 0),
        0,
      ),
      // The earliest running start: two devices running the same task count once live.
      runningSince:
        live
          .filter((s) => s.endedAt === null)
          .map((s) => s.startedAt)
          .sort()[0] ?? null,
    };
  }

  /** The panel's chrono: total and segments, most recent first. */
  timeOf(taskId: string): TaskTime {
    const segments: TimeSegment[] = this.live(taskId)
      .slice()
      .sort((a, b) =>
        a.startedAt === b.startedAt
          ? b.id.localeCompare(a.id)
          : b.startedAt.localeCompare(a.startedAt),
      )
      .map((s) => ({
        id: s.id,
        source: s.source,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        stopReason: s.stopReason,
        note: s.note,
        seconds: s.endedAt ? secondsBetween(s.startedAt, s.endedAt) : 0,
      }));
    return {
      chrono: this.chronoOf(taskId) ?? { seconds: 0, runningSince: null },
      segments,
    };
  }
}
