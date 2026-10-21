/**
 * Header of « Prochainement »: the month button
 * (« Octobre 2026 ▾ ») opens the date picker and jumps to the chosen day's week; ‹ Aujourd'hui ›
 * move by week; the strip of seven days (« Lun 28 » … « Dim 4 ») scrolls to a day. Today's
 * number sits in the accent pill (red is reserved for « Claude attend », D8). Days before
 * today are muted and inert: they show no task.
 */

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { ViewModel } from "../../bindings";
import { IconButton } from "../../components/Button";
import { DatePickerPopover } from "../../components/DatePicker";
import { t } from "../../i18n";
import { parseLocalDate } from "../../lib/dates";
import { useUi } from "../../stores/ui";
import { useList } from "./listStore";
import {
  mondayOf,
  monthLabel,
  shiftDays,
  weekDays,
  weekdayName,
  weekdayShort,
} from "./upcomingModel";

function scrollToGroup(el: Element): void {
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "start" });
  }
}

/**
 * Scrolls to a day's group: now when it is rendered, else as soon as it is (after a week
 * change, see `scrollToPendingDay`). No timer: none can outlive the screen.
 */
export function scrollToDay(date: string): void {
  const el = document.querySelector(`[data-group="day:${date}"]`);
  useList.setState({ pendingScrollDay: el ? null : date });
  if (el) scrollToGroup(el);
}

/** Called by a day group when its element is rendered: scrolls to it if a jump waits for it. */
export function scrollToPendingDay(date: string, el: Element): void {
  if (useList.getState().pendingScrollDay !== date) return;
  useList.setState({ pendingScrollDay: null });
  scrollToGroup(el);
}

/** Number of open tasks a day shows (its group in the view, if loaded). */
function countOf(view: ViewModel | undefined, date: string): number {
  const group = view?.groups.find(
    (g) => g.key.type === "day" && g.key.date === date,
  );
  return group?.tasks.length ?? 0;
}

export function UpcomingBar({
  monday,
  today,
  view,
}: {
  /** First day of the week shown. */
  monday: string;
  /** Local `YYYY-MM-DD` of today. */
  today: string;
  view: ViewModel | undefined;
}) {
  const setWeek = useUi((s) => s.setUpcomingWeek);
  const monthRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const thisWeek = mondayOf(today);
  const days = weekDays(monday);
  // The month of the first day that shows tasks (today in the current week).
  const shownFrom = monday < today ? today : monday;

  const goTo = (date: string) => {
    useList.getState().openEditor(null);
    // Days before today are inert: a past day (month picker) goes to today's week.
    const target = date < today ? today : date;
    const week = mondayOf(target);
    setWeek(week === thisWeek ? null : week);
    scrollToDay(target);
  };

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-center justify-between gap-2">
        <button
          ref={monthRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-label={t.upcoming.monthPicker(monthLabel(shownFrom))}
          onClick={() => setPickerOpen((o) => !o)}
          className="-ml-1.5 inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[14px] font-semibold hover:bg-hover"
        >
          {monthLabel(shownFrom)}
          <ChevronDown size={15} aria-hidden className="text-text-2" />
        </button>
        {pickerOpen && (
          <DatePickerPopover
            anchorRef={monthRef}
            label={t.upcoming.monthPicker(monthLabel(shownFrom))}
            dateOnly
            value={{ date: shownFrom, time: null }}
            onChange={(v) => {
              if (v.date) goTo(v.date);
            }}
            onClose={(restoreFocus) => {
              setPickerOpen(false);
              if (restoreFocus) monthRef.current?.focus();
            }}
          />
        )}
        <div className="flex items-center gap-0.5">
          <IconButton
            label={t.upcoming.previousWeek}
            size={28}
            disabled={monday <= thisWeek}
            onClick={() => goTo(shiftDays(monday, -7))}
          >
            <ChevronLeft size={16} aria-hidden />
          </IconButton>
          <button
            type="button"
            onClick={() => goTo(today)}
            className="h-7 rounded-md border border-border px-2 text-[12.5px] font-medium text-text-2 hover:bg-hover hover:text-text"
          >
            {t.upcoming.today}
          </button>
          <IconButton
            label={t.upcoming.nextWeek}
            size={28}
            onClick={() => goTo(shiftDays(monday, 7))}
          >
            <ChevronRight size={16} aria-hidden />
          </IconButton>
        </div>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a strip of day buttons, not a fieldset */}
      <div
        role="group"
        aria-label={t.upcoming.weekLabel}
        data-week-strip
        className="grid grid-cols-7 border-b border-border pb-2"
      >
        {days.map((date) => {
          const past = date < today;
          const isToday = date === today;
          const count = countOf(view, date);
          const name = `${weekdayName(date)} ${parseLocalDate(date).getDate()}`;
          return (
            <button
              key={date}
              type="button"
              data-day={date}
              disabled={past}
              aria-current={isToday ? "date" : undefined}
              aria-label={t.upcoming.dayButton(name, count)}
              onClick={() => scrollToDay(date)}
              className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-md text-[12px] ${
                past ? "text-text-3" : "text-text-2 hover:bg-hover"
              }`}
            >
              <span>{weekdayShort(date)}</span>
              <span
                className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[13px] tabular-nums ${
                  isToday
                    ? "bg-accent font-semibold text-on-accent"
                    : past
                      ? ""
                      : "font-medium text-text"
                }`}
              >
                {parseLocalDate(date).getDate()}
              </span>
              {/* A dot under the days that have tasks (2026-10-12). */}
              <span
                aria-hidden="true"
                data-has-tasks={count > 0 || undefined}
                className={`h-1 w-1 rounded-full ${count > 0 ? "bg-accent" : "bg-transparent"}`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
