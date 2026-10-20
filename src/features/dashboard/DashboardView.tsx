/**
 * Dashboard of a project, or of « Sans projet » : six figures, time per day, the next due dates, late and blocked tasks, lingering ones,
 * time per task. The core computes everything (`get_dashboard`); a task opens its panel.
 *
 * The chart follows the dataviz method: one stacked bar per day (Claude, by hand), a legend
 * (two series), a 2 px gap between segments, 4 px rounded tops, a hover tooltip per day, and
 * colors validated by the dataviz validator (`--chart-auto`, `--chart-manual`).
 *
 * Web app: nothing tied to the local Claude sessions (« attend ta réponse »); on
 * a phone the figures go two by two, the blocks one under the other.
 */

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { Dashboard, DashboardTask, DayTime } from "../../bindings";
import { Button } from "../../components/Button";
import { t as strings } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { formatDue, formatLongDate } from "../../lib/dates";
import { commands } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import { IS_MOBILE } from "../../lib/target";
import { useUi } from "../../stores/ui";
import { formatHours } from "../chrono/chrono";

export function useDashboard(subjectId: string | null, days: number) {
  return useQuery({
    queryKey: queryKeys.dashboard(subjectId, days),
    queryFn: () => commands.getDashboard(subjectId, days),
  });
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "late" | "blocked";
}) {
  const color =
    tone === "late"
      ? "text-due-overdue"
      : tone === "blocked"
        ? "text-waiting-text"
        : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-border px-4 py-3">
      <span className="text-[12.5px] text-text-2">{label}</span>
      <span
        className={`text-[26px] leading-8 font-semibold tabular-nums ${color}`}
      >
        {value}
      </span>
      <span className="truncate text-[12px] text-text-3" title={hint}>
        {hint}
      </span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border px-4 py-3">
      <h2 className="mb-2 text-[12.5px] font-medium text-text-2">{title}</h2>
      {children}
    </section>
  );
}

/** A task line of a block: title (opens the panel), then what the block says about it. */
function TaskLine({
  task,
  meta,
  tone,
}: {
  task: DashboardTask;
  meta: string;
  tone?: string;
}) {
  const openTask = useUi((s) => s.openTask);
  return (
    <li className="flex min-w-0 items-baseline gap-3 py-1">
      <button
        type="button"
        onClick={() => openTask(task.id)}
        className="min-w-0 flex-1 truncate text-left text-[13.5px] text-text hover:underline"
      >
        {task.title}
      </button>
      <span
        className={`shrink-0 text-[12.5px] tabular-nums ${tone ?? "text-text-2"}`}
      >
        {meta}
      </span>
    </li>
  );
}

const Empty = ({ text }: { text: string }) => (
  <p className="py-1 text-[13px] text-text-3">{text}</p>
);

function weekdayLabel(date: string, all: number): string {
  const d = new Date(`${date}T12:00:00`);
  if (all <= 7) {
    return d.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "");
  }
  return String(d.getDate());
}

/** Time per day: stacked bars (Claude below, by hand above), one per day. */
function TimeChart({ days }: { days: DayTime[] }) {
  const agent = useDefaultAgent();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.autoSeconds + d.manualSeconds));
  const HEIGHT = 120;
  const tip = hover === null ? null : days[hover];
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-2">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "var(--chart-auto)" }}
          />
          {strings.dashboard.auto(agent)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "var(--chart-manual)" }}
          />
          {strings.dashboard.manual}
        </span>
      </div>
      <div className="relative">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover only hides the tooltip; the table below gives the same figures */}
        <div
          className="flex items-end gap-[2px] border-b border-border"
          style={{ height: HEIGHT }}
          onMouseLeave={() => setHover(null)}
        >
          {days.map((d, i) => {
            const auto = (d.autoSeconds / max) * (HEIGHT - 4);
            const manual = (d.manualSeconds / max) * (HEIGHT - 4);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows the tooltip; the table below gives the same figures
              <div
                key={d.date}
                className="flex h-full min-w-0 flex-1 flex-col-reverse items-center justify-start gap-[2px]"
                onMouseEnter={() => setHover(i)}
                data-day={d.date}
              >
                {auto > 0 && (
                  <span
                    className={`block w-full max-w-[36px] ${manual > 0 ? "" : "rounded-t-[4px]"}`}
                    style={{
                      height: auto,
                      background: "var(--chart-auto)",
                      opacity: hover === null || hover === i ? 1 : 0.55,
                    }}
                  />
                )}
                {manual > 0 && (
                  <span
                    className="block w-full max-w-[36px] rounded-t-[4px]"
                    style={{
                      height: manual,
                      background: "var(--chart-manual)",
                      opacity: hover === null || hover === i ? 1 : 0.55,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        {tip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-elevated px-2 py-1 text-[12px] whitespace-nowrap text-text shadow-pop"
          >
            {strings.dashboard.dayTip(
              formatLongDate(tip.date),
              formatHours(tip.autoSeconds),
              formatHours(tip.manualSeconds),
              agent,
            )}
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-[2px] text-[11px] text-text-3">
        {days.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 truncate text-center">
            {days.length <= 7 || i % 5 === 0 || i === days.length - 1
              ? weekdayLabel(d.date, days.length)
              : ""}
          </span>
        ))}
      </div>
      {/* The same figures for screen readers (the chart's table view). */}
      <table className="sr-only">
        <caption>{strings.dashboard.timeByDay}</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{formatLongDate(d.date)}</th>
              <td>{formatHours(d.autoSeconds)}</td>
              <td>{formatHours(d.manualSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PeriodPicker() {
  const days = useUi((s) => s.dashboardDays);
  const setDays = useUi((s) => s.setDashboardDays);
  return (
    <div
      role="radiogroup"
      aria-label={strings.dashboard.period}
      className="inline-flex rounded-lg bg-hover p-0.5"
    >
      {([7, 30] as const).map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={days === n}
          onClick={() => setDays(n)}
          className={`h-7 rounded-md px-3 text-[13px] ${
            days === n
              ? "bg-bg font-medium text-text shadow-sm"
              : "text-text-2 hover:text-text"
          }`}
        >
          {strings.dashboard.days(n)}
        </button>
      ))}
    </div>
  );
}

function Figures({ d }: { d: Dashboard }) {
  return (
    <div
      className={`grid gap-3 ${
        IS_MOBILE
          ? "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"
      }`}
      data-dashboard-figures
    >
      <Tile
        label={strings.dashboard.open}
        value={String(d.open + d.openSubtasks)}
        hint={`${strings.dashboard.withSubtasks(d.openSubtasks)} · ${strings.dashboard.openDelta(d.openDelta, d.days)}`}
      />
      <Tile
        label={strings.dashboard.done}
        value={String(d.done)}
        hint={strings.dashboard.doneBefore(d.doneBefore)}
      />
      <Tile
        label={strings.dashboard.overdue}
        value={String(d.overdue)}
        hint={strings.dashboard.overdueHint}
        tone={d.overdue > 0 ? "late" : undefined}
      />
      <Tile
        label={strings.dashboard.blocked}
        value={String(d.blocked)}
        hint={
          IS_MOBILE
            ? strings.dashboard.blockedHintWeb(d.blockedByRelation)
            : strings.dashboard.blockedHint(
                d.blockedByRelation,
                d.blockedWaiting,
              )
        }
        tone={d.blocked > 0 ? "blocked" : undefined}
      />
      <Tile
        label={strings.dashboard.time}
        value={formatHours(d.seconds)}
        hint={
          d.secondsPerDone === null
            ? strings.dashboard.noneDone
            : strings.dashboard.perDone(formatHours(d.secondsPerDone))
        }
      />
      <Tile
        label={strings.dashboard.oldest}
        value={
          d.oldest ? strings.dashboard.oldestValue(d.oldest.days ?? 0) : "—"
        }
        hint={d.oldest?.title ?? strings.dashboard.noOpen}
      />
    </div>
  );
}

export function DashboardView({ subjectId }: { subjectId: string | null }) {
  const days = useUi((s) => s.dashboardDays);
  const { data: d, error, refetch } = useDashboard(subjectId, days);
  if (!d) {
    return (
      <div className="py-6 text-[13.5px] text-text-2">
        {error ? (
          <span className="flex items-center gap-3">
            {strings.dashboard.error}
            <Button size="sm" onClick={() => void refetch()}>
              {strings.dashboard.retry}
            </Button>
          </span>
        ) : (
          strings.dashboard.loading
        )}
      </div>
    );
  }
  // The web has no Claude session of its own: no « attend ta réponse » line.
  const lateOrBlocked = IS_MOBILE
    ? d.lateOrBlocked.filter((t) => t.reason?.kind !== "waiting")
    : d.lateOrBlocked;
  const reason = (t: DashboardTask): string => {
    const r = t.reason;
    if (!r) return "";
    if (r.kind === "overdue") return strings.dashboard.late(r.days);
    if (r.kind === "blocked_by") return strings.dashboard.blockedBy(r.title);
    return strings.dashboard.waiting;
  };
  return (
    <div className="flex flex-col gap-3 pb-16">
      <div>
        <PeriodPicker />
      </div>
      <Figures d={d} />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[2fr_1fr]">
        <Block title={strings.dashboard.timeByDay}>
          <TimeChart days={d.timeByDay} />
        </Block>
        <Block title={strings.dashboard.upcoming}>
          {d.upcoming.length === 0 ? (
            <Empty text={strings.dashboard.noUpcoming} />
          ) : (
            <ul>
              {d.upcoming.map((t) => (
                <TaskLine
                  key={t.id}
                  task={t}
                  meta={t.due ? formatDue(t.due) : ""}
                />
              ))}
            </ul>
          )}
          <p className="mt-1 text-[12px] text-text-3">
            {strings.dashboard.undated(d.undated)}
          </p>
        </Block>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Block title={strings.dashboard.lateOrBlocked}>
          {lateOrBlocked.length === 0 ? (
            <Empty text={strings.dashboard.nothingLate} />
          ) : (
            <ul>
              {lateOrBlocked.map((t) => (
                <TaskLine
                  key={t.id}
                  task={t}
                  meta={reason(t)}
                  tone={
                    t.reason?.kind === "overdue"
                      ? "text-due-overdue"
                      : "text-text-2"
                  }
                />
              ))}
            </ul>
          )}
        </Block>
        <Block title={strings.dashboard.lingering}>
          {d.lingering.length === 0 ? (
            <Empty text={strings.dashboard.noOpen} />
          ) : (
            <ul>
              {d.lingering.map((t) => (
                <TaskLine
                  key={t.id}
                  task={t}
                  meta={strings.dashboard.age(t.days ?? 0)}
                />
              ))}
            </ul>
          )}
        </Block>
        <Block title={strings.dashboard.timeByTask(d.days)}>
          {d.timeByTask.length === 0 ? (
            <Empty text={strings.dashboard.noTime} />
          ) : (
            <ul>
              {d.timeByTask.map((t) => (
                <TaskLine
                  key={t.id}
                  task={t}
                  meta={formatHours(t.seconds ?? 0)}
                />
              ))}
            </ul>
          )}
        </Block>
      </div>
    </div>
  );
}

/** The compact strip above a project's list (wireframe V2·1): five figures of the week. */
export function ProjectStrip({ subjectId }: { subjectId: string | null }) {
  const { data: d } = useDashboard(subjectId, 7);
  const setTab = useUi((s) => s.setProjectTab);
  if (!d) return null;
  const parts = [
    strings.dashboard.stripOpen(d.open),
    strings.dashboard.stripDone(d.done),
    strings.dashboard.stripLate(d.overdue),
    strings.dashboard.stripBlocked(d.blocked),
    strings.dashboard.stripTime(formatHours(d.seconds)),
  ];
  return (
    <button
      type="button"
      aria-label={`${strings.dashboard.strip} : ${parts.join(", ")}. ${strings.dashboard.stripOpenDashboard}`}
      title={strings.dashboard.stripOpenDashboard}
      onClick={() => setTab("dashboard")}
      className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 rounded-md text-left text-[12.5px] text-text-3 hover:text-text-2"
      data-project-strip
    >
      {parts.map((p, i) => (
        <span
          key={p}
          className={
            i === 2 && d.overdue > 0
              ? "text-due-overdue"
              : i === 3 && d.blocked > 0
                ? "text-waiting-text"
                : ""
          }
        >
          {p}
        </span>
      ))}
    </button>
  );
}
