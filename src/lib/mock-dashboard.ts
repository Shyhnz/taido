/**
 * The dashboard of the mock backend (Taido V2.5), following the core's `views::dashboard`:
 * the same figures and blocks, computed from the mock's tasks, chrono and relations.
 */

import type { Dashboard, DashboardTask, Due } from "../bindings";
import { toLocalDateString } from "./dates";

export interface DashTask {
  id: string;
  title: string;
  due: Due | null;
  dueDate: string | null;
  dueTime: string | null;
  completedAt: string | null;
  createdAt: string;
  blockedBy: string | null;
  waiting: boolean;
}

export interface DashSegment {
  /** Its top-level task. */
  taskId: string;
  manual: boolean;
  start: number;
  end: number;
}

const DAY = 86_400_000;
const LIST_MAX = 5;

const midnight = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const overlap = (s: DashSegment, a: number, b: number) =>
  Math.max(0, Math.min(s.end, b) - Math.max(s.start, a));

const secs = (ms: number) => Math.max(0, Math.floor(ms / 1000));

export function mockDashboard(
  all: DashTask[],
  segments: DashSegment[],
  daysIn: number,
  now: Date,
  openSubtasks = 0,
): Dashboard {
  const days = Math.min(366, Math.max(1, daysIn));
  const today = midnight(now);
  const todayStr = toLocalDateString(now);
  const from = today - (days - 1) * DAY;
  const before = from - days * DAY;
  const t = now.getTime();
  const at = (iso: string | null) => (iso ? Date.parse(iso) : null);
  const open = all.filter((x) => x.completedAt === null);
  const inRange = (iso: string | null, a: number, b: number) => {
    const v = at(iso);
    return v !== null && v >= a && v < b;
  };
  const done = all.filter((x) => inRange(x.completedAt, from, t + 1000));
  const doneBefore = all.filter((x) => inRange(x.completedAt, before, from));
  const openAtStart = all.filter(
    (x) =>
      Date.parse(x.createdAt) < from &&
      (x.completedAt === null || Date.parse(x.completedAt) >= from),
  ).length;
  const lateDays = (x: DashTask) =>
    x.dueDate !== null && x.dueDate < todayStr
      ? Math.round((today - midnight(new Date(`${x.dueDate}T00:00:00`))) / DAY)
      : null;
  const age = (x: DashTask) =>
    Math.max(0, Math.round((today - midnight(new Date(x.createdAt))) / DAY));
  const item = (x: DashTask): DashboardTask => ({
    id: x.id,
    title: x.title,
    due: x.due,
    days: null,
    seconds: null,
    reason: null,
  });

  const perTask = new Map<string, number>();
  let total = 0;
  for (const s of segments) {
    const d = overlap(s, from, t);
    if (d > 0) {
      perTask.set(s.taskId, (perTask.get(s.taskId) ?? 0) + d);
      total += d;
    }
  }
  const timeByDay = Array.from({ length: days }, (_, i) => {
    const a = from + i * DAY;
    const b = Math.min(a + DAY, t);
    let auto = 0;
    let manual = 0;
    for (const s of segments) {
      const d = overlap(s, a, b);
      if (s.manual) manual += d;
      else auto += d;
    }
    return {
      date: toLocalDateString(new Date(a)),
      autoSeconds: secs(auto),
      manualSeconds: secs(manual),
    };
  });
  const doneTime = done.reduce(
    (sum, x) =>
      sum +
      segments
        .filter((s) => s.taskId === x.id)
        .reduce((a, s) => a + (s.end - s.start), 0),
    0,
  );
  const byAge = [...open].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const dated = open
    .filter((x) => x.dueDate !== null && x.dueDate >= todayStr)
    .sort((a, b) =>
      `${a.dueDate} ${a.dueTime ?? "99:99"}`.localeCompare(
        `${b.dueDate} ${b.dueTime ?? "99:99"}`,
      ),
    );
  const late = open
    .map((x) => [x, lateDays(x)] as const)
    .filter((p): p is readonly [DashTask, number] => p[1] !== null)
    .sort((a, b) => b[1] - a[1]);
  const lateOrBlocked: DashboardTask[] = [
    ...late.map(([x, d]) => ({
      ...item(x),
      days: d,
      reason: { kind: "overdue" as const, days: d },
    })),
    ...open
      .filter((x) => lateDays(x) === null && (x.blockedBy || x.waiting))
      .map((x) => ({
        ...item(x),
        reason: x.blockedBy
          ? { kind: "blocked_by" as const, title: x.blockedBy }
          : { kind: "waiting" as const },
      })),
  ];
  const byId = new Map(all.map((x) => [x.id, x]));
  const timeByTask = [...perTask.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .flatMap(([id, ms]) => {
      const x = byId.get(id);
      return x ? [{ ...item(x), seconds: secs(ms) }] : [];
    })
    .slice(0, LIST_MAX);

  return {
    days,
    open: open.length,
    openDelta: open.length - openAtStart,
    openSubtasks,
    done: done.length,
    doneBefore: doneBefore.length,
    overdue: late.length,
    blocked: open.filter((x) => x.blockedBy !== null || x.waiting).length,
    blockedByRelation: open.filter((x) => x.blockedBy !== null).length,
    blockedWaiting: open.filter((x) => x.waiting).length,
    seconds: secs(total),
    secondsPerDone:
      done.length > 0 ? Math.floor(secs(doneTime) / done.length) : null,
    oldest: byAge[0] ? { ...item(byAge[0]), days: age(byAge[0]) } : null,
    timeByDay,
    upcoming: dated.slice(0, LIST_MAX).map(item),
    undated: open.filter((x) => x.dueDate === null).length,
    lateOrBlocked,
    lingering: byAge
      .slice(0, LIST_MAX)
      .map((x) => ({ ...item(x), days: age(x) })),
    timeByTask,
  };
}
