/**
 * « Portefeuille » (Taido V2.6): every project on one
 * line, over 7 or 30 days, sortable on every column (by default the next due task first),
 * four global figures, and « Exporter les temps (CSV) ». A project opens its dashboard.
 *
 * Web app (Taido V2.8, large screen only): no « Sessions » column (no Claude on the web) and
 * the export downloads the file (`saveBlob`) instead of writing it in Documents.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { useState } from "react";
import type { PortfolioRow } from "../../bindings";
import { Button } from "../../components/Button";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { formatDue, formatRelative, toLocalDateString } from "../../lib/dates";
import { subjectColorVar } from "../../lib/format";
import { commands, webTimeCsv } from "../../lib/ipc";
import { run } from "../../lib/run";
import { IS_MOBILE } from "../../lib/target";
import { saveBlob } from "../../lib/web-files";
import { useUi } from "../../stores/ui";
import { formatHours } from "../chrono/chrono";
import { PeriodPicker } from "../dashboard/DashboardView";

type SortKey =
  | "project"
  | "open"
  | "done"
  | "overdue"
  | "blocked"
  | "next"
  | "sessions"
  | "time"
  | "last";

/** Value a column sorts on; `null` always goes last. */
function sortValue(r: PortfolioRow, key: SortKey): string | number | null {
  switch (key) {
    case "project":
      return (r.group ? `${r.group} › ${r.name}` : r.name).toLocaleLowerCase(
        "fr",
      );
    case "open":
      return r.open;
    case "done":
      return r.done;
    case "overdue":
      return r.overdue;
    case "blocked":
      return r.blocked;
    case "next":
      return r.next?.due
        ? `${r.next.due.date} ${r.next.due.time ?? "99:99"}`
        : null;
    case "sessions":
      return r.sessionsRunning + r.sessionsWaiting;
    case "time":
      return r.seconds;
    case "last":
      return r.lastActivity;
  }
}

export function sortRows(
  rows: PortfolioRow[],
  key: SortKey,
  asc: boolean,
): PortfolioRow[] {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return asc ? c : -c;
  });
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  /** Small line under the figure (« dont 4 sous-tâches »). */
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-border px-4 py-3">
      <span className="text-[12.5px] text-text-2">{label}</span>
      <span
        className={`text-[26px] leading-8 font-semibold tabular-nums ${tone ?? "text-text"}`}
      >
        {value}
      </span>
      {hint && <span className="truncate text-[12px] text-text-3">{hint}</span>}
    </div>
  );
}

export function PortfolioView() {
  const days = useUi((s) => s.dashboardDays);
  const setView = useUi((s) => s.setView);
  const setTab = useUi((s) => s.setProjectTab);
  // Spec: by default the nearest next due task first.
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: "next",
    asc: true,
  });
  const {
    data: p,
    error,
    refetch,
  } = useQuery({
    queryKey: ["view", "portfolio", days],
    queryFn: () => commands.getPortfolio(days),
  });

  const exportCsv = async () => {
    const fileName = t.portfolio.fileName(toLocalDateString(new Date()), days);
    if (IS_MOBILE) {
      const csv = webTimeCsv(days);
      if (csv === null) return;
      saveBlob(new Blob([csv], { type: "text/csv" }), fileName);
      showToast({ message: t.portfolio.downloaded(fileName) });
      return;
    }
    const path = await run(commands.exportTimeCsv(days, fileName));
    if (path) showToast({ message: t.portfolio.exported(path) });
  };
  const open = (r: PortfolioRow) => {
    setView({ kind: "subject", subjectId: r.subjectId });
    setTab("dashboard");
  };
  // No Claude on the web: its « Sessions » column would always say « aucune ».
  const sessions = !IS_MOBILE;
  const allColumns: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: "project", label: t.portfolio.cols.project },
    { key: "open", label: t.portfolio.cols.open, numeric: true },
    { key: "done", label: t.portfolio.cols.done(days), numeric: true },
    { key: "overdue", label: t.portfolio.cols.overdue, numeric: true },
    { key: "blocked", label: t.portfolio.cols.blocked, numeric: true },
    { key: "next", label: t.portfolio.cols.next },
    { key: "sessions", label: t.portfolio.cols.sessions },
    { key: "time", label: t.portfolio.cols.time(days), numeric: true },
    { key: "last", label: t.portfolio.cols.last },
  ];
  const columns = sessions
    ? allColumns
    : allColumns.filter((c) => c.key !== "sessions");

  return (
    <div className="pb-16">
      <header className="flex flex-wrap items-end gap-3 pt-10 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-title leading-8 font-bold">
            {t.portfolio.title}
          </h1>
          <p className="mt-0.5 text-[13px] text-text-2">
            {t.portfolio.subtitle}
          </p>
        </div>
        <PeriodPicker />
        <Button size="sm" onClick={() => void exportCsv()}>
          <Download size={14} aria-hidden />
          {t.portfolio.export}
        </Button>
      </header>
      {!p ? (
        <p className="py-6 text-[13.5px] text-text-2">
          {error ? (
            <span className="flex items-center gap-3">
              {t.portfolio.error}
              <Button size="sm" onClick={() => void refetch()}>
                {t.dashboard.retry}
              </Button>
            </span>
          ) : (
            t.portfolio.loading
          )}
        </p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Figure
              label={t.portfolio.open}
              value={String(p.open + p.openSubtasks)}
              hint={t.dashboard.withSubtasks(p.openSubtasks)}
            />
            <Figure label={t.portfolio.done(p.days)} value={String(p.done)} />
            <Figure
              label={t.portfolio.overdue}
              value={String(p.overdue)}
              tone={p.overdue > 0 ? "text-due-overdue" : undefined}
            />
            <Figure
              label={t.portfolio.time(p.days)}
              value={formatHours(p.seconds)}
            />
          </div>
          {p.rows.length === 0 ? (
            <p className="text-[13.5px] text-text-2">{t.portfolio.empty}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[860px] border-collapse text-[13px]">
                <caption className="sr-only">{t.portfolio.table}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-[12px] text-text-2">
                    {columns.map((c) => {
                      const active = sort.key === c.key;
                      const Arrow = sort.asc ? ArrowUp : ArrowDown;
                      return (
                        <th
                          key={c.key}
                          scope="col"
                          aria-sort={
                            active
                              ? sort.asc
                                ? "ascending"
                                : "descending"
                              : undefined
                          }
                          className={`px-3 py-2 font-medium ${c.numeric ? "text-right" : ""}`}
                        >
                          <button
                            type="button"
                            title={t.portfolio.sortBy(c.label)}
                            onClick={() =>
                              setSort((s) => ({
                                key: c.key,
                                asc: s.key === c.key ? !s.asc : !c.numeric,
                              }))
                            }
                            className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}
                          >
                            {c.label}
                            {active && <Arrow size={12} aria-hidden />}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortRows(p.rows, sort.key, sort.asc).map((r) => (
                    <tr
                      key={r.subjectId}
                      className="border-b border-border last:border-b-0 hover:bg-hover/50"
                      data-portfolio-row={r.subjectId}
                    >
                      <th
                        scope="row"
                        className="px-3 py-2 text-left font-normal"
                      >
                        <button
                          type="button"
                          onClick={() => open(r)}
                          title={t.portfolio.openDashboard(r.name)}
                          className="inline-flex max-w-[240px] items-center gap-2 text-left hover:underline"
                        >
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: subjectColorVar(r.color) }}
                          />
                          <span className="truncate">
                            {r.group && (
                              <span className="text-text-3">{r.group} › </span>
                            )}
                            <span className="font-medium text-text">
                              {r.name}
                            </span>
                          </span>
                        </button>
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.open}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.done}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${r.overdue > 0 ? "font-medium text-due-overdue" : "text-text-3"}`}
                      >
                        {r.overdue}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${r.blocked > 0 ? "font-medium text-waiting-text" : "text-text-3"}`}
                      >
                        {r.blocked}
                      </td>
                      <td className="max-w-[220px] px-3 py-2">
                        {r.next ? (
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-text">
                              {r.next.title}
                            </span>
                            {r.next.due && (
                              <span
                                className={`text-[12px] ${r.next.due.overdue ? "text-due-overdue" : "text-text-3"}`}
                              >
                                {formatDue(r.next.due)}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-text-3">
                            {t.portfolio.noDated}
                          </span>
                        )}
                      </td>
                      {sessions && (
                        <td className="px-3 py-2">
                          {r.sessionsRunning + r.sessionsWaiting === 0 ? (
                            <span className="text-text-3">
                              {t.portfolio.noSession}
                            </span>
                          ) : (
                            <span className="inline-flex gap-1">
                              {r.sessionsRunning > 0 && (
                                <span
                                  title={t.portfolio.running(r.sessionsRunning)}
                                  className="min-w-[20px] rounded-full bg-accent px-1.5 text-center text-[11.5px] leading-[18px] font-semibold text-on-accent tabular-nums"
                                >
                                  {r.sessionsRunning}
                                  <span className="sr-only">
                                    {" "}
                                    {t.portfolio.running(r.sessionsRunning)}
                                  </span>
                                </span>
                              )}
                              {r.sessionsWaiting > 0 && (
                                <span
                                  title={t.portfolio.waiting(r.sessionsWaiting)}
                                  className="min-w-[20px] rounded-full bg-waiting px-1.5 text-center text-[11.5px] leading-[18px] font-semibold text-on-waiting tabular-nums"
                                >
                                  {r.sessionsWaiting}
                                  <span className="sr-only">
                                    {" "}
                                    {t.portfolio.waiting(r.sessionsWaiting)}
                                  </span>
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatHours(r.seconds)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.inactiveDays !== null ? (
                          <span className="rounded-md bg-hover px-1.5 py-0.5 text-[12px] text-text-2">
                            {t.portfolio.inactive(r.inactiveDays)}
                          </span>
                        ) : (
                          <span className="text-text-2">
                            {r.lastActivity
                              ? formatRelative(r.lastActivity)
                              : t.portfolio.never}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[12px] text-text-3">{t.portfolio.footnote}</p>
        </>
      )}
    </div>
  );
}
