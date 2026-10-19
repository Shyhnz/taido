/**
 * « Prochainement » as a month calendar (2026-10-12, artifact « Prochainement : liste
 * ou calendrier »): whole weeks, Monday first; each day shows up to two tasks then « + N
 * autres », late tasks on their due day in the overdue colour. A task opens its panel; a day's
 * number goes to that day in the list; a task dragged onto another day (today or later) moves
 * there, its time kept. On a phone the cells show coloured dots instead: a tap selects the
 * day, whose tasks show under the grid, and a long press drags one onto another day.
 */

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { TaskRow, ViewModel } from "../../bindings";
import { IconButton } from "../../components/Button";
import { fr } from "../../i18n/fr";
import { parseLocalDate } from "../../lib/dates";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { useMediaQuery } from "../../lib/screen";
import { useUi } from "../../stores/ui";
import { type DragData, dragId } from "../dnd/DndProvider";
import { isTouchContextMenu } from "../dnd/sensors";
import { scrollToDay } from "./UpcomingBar";
import {
  calendarDays,
  longDay,
  mondayOf,
  monthLabel,
  monthOf,
  shiftMonths,
  weekdayName,
} from "./upcomingModel";

/** Width from which the cells show their tasks (Tailwind `sm`); below, dots. */
const WIDE_QUERY = "(min-width: 640px)";

/** Tasks a day shows before « + N autres ». */
const SHOWN_PER_DAY = 2;

interface DayTask {
  row: TaskRow;
  late: boolean;
}

/** Open tasks by due day: the day groups, and the late ones on the day they were due. */
export function tasksByDay(view: ViewModel): Map<string, DayTask[]> {
  const byDay = new Map<string, DayTask[]>();
  const push = (date: string, task: DayTask) => {
    const list = byDay.get(date);
    if (list) list.push(task);
    else byDay.set(date, [task]);
  };
  for (const group of view.groups) {
    if (group.key.type === "day") {
      for (const row of group.tasks) push(group.key.date, { row, late: false });
    } else if (group.key.type === "today_overdue") {
      for (const row of group.tasks) {
        if (row.due) push(row.due.date, { row, late: true });
      }
    }
  }
  return byDay;
}

/** Goes to `date` in the list (today's week for a past day). */
function openInList(date: string, today: string) {
  const ui = useUi.getState();
  const target = date < today ? today : date;
  const week = mondayOf(target);
  ui.setUpcomingWeek(week === mondayOf(today) ? null : week);
  ui.setUpcomingMode("list");
  scrollToDay(target);
}

export function UpcomingCalendar({
  month,
  view,
}: {
  /** First day of the month shown. */
  month: string;
  view: ViewModel;
}) {
  const setMonth = useUi((s) => s.setUpcomingMonth);
  const wide = useMediaQuery(WIDE_QUERY);
  const today = view.today;
  const thisMonth = monthOf(today);
  const days = calendarDays(month);
  const byDay = tasksByDay(view);
  const weeks = days.length / 7;
  // Phone: the day whose tasks show under the grid; today, or the 1st of another month.
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = month === thisMonth ? today : month;
  const selected = picked && days.includes(picked) ? picked : fallback;
  const go = (m: string) => {
    setPicked(null);
    setMonth(m === thisMonth ? null : m);
  };
  const selectedTasks = byDay.get(selected) ?? [];

  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">{monthLabel(month)}</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            label={fr.upcoming.previousMonth}
            size={28}
            onClick={() => go(shiftMonths(month, -1))}
          >
            <ChevronLeft size={16} aria-hidden />
          </IconButton>
          <button
            type="button"
            onClick={() => go(thisMonth)}
            className="h-7 rounded-md border border-border px-2 text-[12.5px] font-medium text-text-2 hover:bg-hover hover:text-text"
          >
            {fr.upcoming.today}
          </button>
          <IconButton
            label={fr.upcoming.nextMonth}
            size={28}
            onClick={() => go(shiftMonths(month, 1))}
          >
            <ChevronRight size={16} aria-hidden />
          </IconButton>
        </div>
      </div>
      <div
        data-calendar={month}
        className="overflow-hidden rounded-lg border border-border"
      >
        <div
          aria-hidden="true"
          className="grid grid-cols-7 border-b border-border bg-sidebar"
        >
          {fr.upcoming.weekdays.map((d) => (
            <div
              key={d}
              className="px-1.5 py-1.5 text-[12px] font-medium text-text-2 sm:px-2.5"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((date, i) => (
            <DayCell
              key={date}
              date={date}
              today={today}
              wide={wide}
              selected={!wide && date === selected}
              onSelect={() => setPicked(date)}
              inMonth={date.startsWith(month.slice(0, 7))}
              lastCol={i % 7 === 6}
              lastRow={i >= (weeks - 1) * 7}
              tasks={byDay.get(date) ?? []}
            />
          ))}
        </div>
      </div>
      {!wide && (
        <section
          aria-label={longDay(selected)}
          data-selected-day={selected}
          className="flex flex-col gap-1.5"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold first-letter:uppercase">
              {longDay(selected)}
            </h3>
            <button
              type="button"
              onClick={() => openInList(selected, today)}
              className="h-8 rounded-md px-2 text-[13px] font-medium text-text-2 hover:bg-hover hover:text-text"
            >
              {fr.upcoming.seeInList}
            </button>
          </div>
          {selectedTasks.length === 0 ? (
            <p className="py-2 text-[13px] text-text-3">
              {fr.upcoming.nothingPlanned}
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {selectedTasks.map((task) => (
                  <li key={task.row.id}>
                    <CalendarChip task={task} date={selected} large />
                  </li>
                ))}
              </ul>
              {features.touchDrag && (
                <p className="text-[12px] text-text-3">
                  {fr.upcoming.dragHint}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** A day of the grid; from today on, it receives the tasks dropped on it. */
function DayCell({
  date,
  today,
  wide,
  selected,
  onSelect,
  inMonth,
  lastCol,
  lastRow,
  tasks,
}: {
  date: string;
  today: string;
  /** Large enough to show the tasks; else dots, and a tap selects the day. */
  wide: boolean;
  selected: boolean;
  onSelect: () => void;
  inMonth: boolean;
  lastCol: boolean;
  lastRow: boolean;
  tasks: DayTask[];
}) {
  const isToday = date === today;
  const d = parseLocalDate(date).getDate();
  const label = `${weekdayName(date)} ${d} ${monthLabel(date)}`;
  const shown = tasks.slice(0, SHOWN_PER_DAY);
  const hidden = tasks.length - shown.length;
  const data: DragData = {
    type: "calendar_day",
    date,
    label: longDay(date),
  };
  const drop = useDroppable({
    id: dragId.calendarDay(date),
    data,
    // A past day would make the task late: it takes no drop.
    disabled: date < today || !(features.dragAndDrop || features.touchDrag),
  });
  const number = (
    <span
      className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12.5px] tabular-nums ${
        isToday
          ? "bg-accent font-semibold text-on-accent"
          : "font-medium text-text"
      }`}
    >
      {d}
    </span>
  );
  return (
    <div
      ref={drop.setNodeRef}
      data-day={date}
      data-drop-over={drop.isOver || undefined}
      className={`flex min-h-[64px] min-w-0 flex-col gap-1 sm:min-h-[112px] sm:p-1.5 ${
        lastCol ? "" : "border-r border-border-row"
      } ${lastRow ? "" : "border-b border-border-row"} ${
        drop.isOver
          ? "bg-nav-active"
          : selected
            ? "bg-hover"
            : isToday
              ? "bg-selected"
              : ""
      } ${inMonth ? "" : "opacity-45"}`}
    >
      {wide ? (
        <>
          <button
            type="button"
            aria-label={fr.upcoming.openDay(label, tasks.length)}
            aria-current={isToday ? "date" : undefined}
            onClick={() => openInList(date, today)}
            className="self-start rounded-full hover:bg-hover"
          >
            {number}
          </button>
          <ul className="flex min-w-0 flex-col gap-1">
            {shown.map((task) => (
              <li key={task.row.id} className="min-w-0">
                <CalendarChip task={task} date={date} />
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => openInList(date, today)}
              className="self-start rounded px-1.5 text-[11.5px] text-text-2 hover:text-text"
            >
              {fr.upcoming.more(hidden)}
            </button>
          )}
        </>
      ) : (
        // Phone: the whole cell selects the day; one dot per task (three at most).
        <button
          type="button"
          aria-label={fr.upcoming.selectDay(label, tasks.length)}
          aria-current={isToday ? "date" : undefined}
          aria-pressed={selected}
          onClick={onSelect}
          className="flex flex-1 flex-col items-start gap-1 p-1"
        >
          {number}
          {tasks.length > 0 && (
            <span aria-hidden="true" className="flex flex-wrap gap-0.5 px-1">
              {tasks.slice(0, 3).map(({ row, late }) => (
                <span
                  key={row.id}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: late
                      ? "var(--due-overdue)"
                      : row.subject
                        ? subjectColorVar(row.subject.color)
                        : "var(--text-3)",
                  }}
                />
              ))}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * A task in a day: a click opens it, a drag (a long press on a phone) moves it to another
 * day, its time kept. `large`: the phone's list under the grid.
 */
function CalendarChip({
  task,
  date,
  large = false,
}: {
  task: DayTask;
  date: string;
  large?: boolean;
}) {
  const { row, late } = task;
  const openTask = useUi((s) => s.openTask);
  const data: DragData = {
    type: "calendar_task",
    taskId: row.id,
    title: row.title,
    date,
    time: row.due?.time ?? null,
  };
  const drag = useDraggable({
    id: dragId.calendarTask(row.id),
    data,
    disabled: !(features.dragAndDrop || features.touchDrag),
  });
  return (
    <button
      type="button"
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      onClick={() => openTask(row.id)}
      // A long press drags: no native menu or text selection.
      onContextMenu={(e) => {
        if (isTouchContextMenu(e)) e.preventDefault();
      }}
      aria-label={late ? fr.upcoming.lateOn(row.title) : undefined}
      className={`flex w-full min-w-0 cursor-grab items-center select-none ${
        large
          ? "min-h-11 gap-2.5 rounded-lg px-3 text-[14px]"
          : "gap-1.5 rounded-[5px] px-1.5 py-[3px] text-[12px]"
      } text-left ${
        late
          ? "text-due-overdue hover:bg-hover"
          : "bg-hover text-text hover:bg-nav-active"
      } ${drag.isDragging ? "opacity-40" : ""}`}
    >
      {row.subject && (
        <span
          aria-hidden="true"
          className={`${large ? "h-2 w-2" : "h-1.5 w-1.5"} shrink-0 rounded-full`}
          style={{ background: subjectColorVar(row.subject.color) }}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        {row.due?.time ? `${row.due.time} ` : ""}
        {row.title}
      </span>
    </button>
  );
}
