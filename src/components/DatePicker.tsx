/**
 * French date picker: quick options (Aujourd'hui, Demain, Lundi prochain), a month
 * grid starting on Monday, an optional time and « Retirer ». It replaces every native date and
 * time input. Nothing is sent per keystroke (bug #1): a day or quick option commits at once,
 * the time field commits on Entrée or when the focus leaves the picker.
 */

import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { fr } from "../i18n/fr";
import { parseLocalDate } from "../lib/dates";
import { IconButton } from "./Button";
import {
  addDaysTo,
  type DueValue,
  dayLabel,
  monthGrid,
  monthOf,
  monthTitle,
  parseTime,
  quickDates,
  quickHint,
  shiftMonth,
  weekdayLabels,
} from "./datePickerModel";
import { Popover } from "./Popover";

export type { DueValue } from "./datePickerModel";

export interface DatePickerProps {
  value: DueValue;
  /** Called once per user decision, never per keystroke. */
  onChange: (value: DueValue) => void;
  /** Clock (tests). */
  now?: Date;
  /**
   * A day only, no time field and no « Retirer » (the month picker of
   * « Prochainement » jumps to a day).
   */
  dateOnly?: boolean;
}

const optionClass =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13.5px] text-text outline-none hover:bg-hover focus-visible:bg-hover";

export function DatePicker({
  value,
  onChange,
  now,
  dateOnly = false,
}: DatePickerProps) {
  const clock = now ?? new Date();
  const quick = quickDates(clock);
  const [month, setMonth] = useState(() =>
    monthOf(value.date ? parseLocalDate(value.date) : clock),
  );
  const [focusDay, setFocusDay] = useState(value.date ?? quick.today);
  const [timeText, setTimeText] = useState(value.time ?? "");
  const [timeError, setTimeError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const timeHelpId = useId();
  const titleId = useId();
  const days = monthGrid(month);
  const labels = weekdayLabels();

  /** Draft time of the field: `undefined` when it is not a valid time. */
  const draftTime = () => parseTime(timeText);

  const pick = (date: string) => {
    const time = draftTime();
    onChange({ date, time: time === undefined ? value.time : time });
  };

  const commitTime = () => {
    const time = draftTime();
    if (time === undefined) {
      setTimeError(true);
      return false;
    }
    setTimeError(false);
    setTimeText(time ?? "");
    if (time === value.time && value.date !== null) return true;
    // A time alone means today (like Todoist).
    if (time === null && value.date === null) return true;
    onChange({ date: value.date ?? quick.today, time });
    return true;
  };

  const onTimeBlur = (e: FocusEvent<HTMLInputElement>) => {
    const next = e.relatedTarget;
    // Clicking a day inside the picker uses the draft time itself.
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    commitTime();
  };

  const moveFocus = (date: string) => {
    setFocusDay(date);
    const target = parseLocalDate(date);
    if (
      target.getMonth() !== month.getMonth() ||
      target.getFullYear() !== month.getFullYear()
    ) {
      setMonth(monthOf(target));
    }
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)
        ?.focus();
    });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const deltas: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = deltas[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      moveFocus(addDaysTo(focusDay, delta));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      moveFocus(addDaysTo(focusDay, e.key === "PageUp" ? -28 : 28));
    }
  };

  // The focusable day: the focused one when shown, else the first of the month.
  const tabbable = days.some((d) => d.date === focusDay && d.inMonth)
    ? focusDay
    : (days.find((d) => d.inMonth)?.date ?? focusDay);

  return (
    <div ref={rootRef} className="flex w-[272px] flex-col p-2">
      <div className="flex flex-col pb-1">
        <button
          type="button"
          className={optionClass}
          onClick={() => pick(quick.today)}
          data-autofocus={value.date === null ? true : undefined}
        >
          <CalendarDays size={15} aria-hidden className="text-text-2" />
          <span className="flex-1">{fr.datePicker.today}</span>
          <span className="text-[12px] text-text-2">
            {quickHint(quick.today, clock)}
          </span>
        </button>
        <button
          type="button"
          className={optionClass}
          onClick={() => pick(quick.tomorrow)}
        >
          <CalendarDays size={15} aria-hidden className="text-text-2" />
          <span className="flex-1">{fr.datePicker.tomorrow}</span>
          <span className="text-[12px] text-text-2">
            {quickHint(quick.tomorrow, clock)}
          </span>
        </button>
        <button
          type="button"
          className={optionClass}
          onClick={() => pick(quick.nextMonday)}
        >
          <CalendarDays size={15} aria-hidden className="text-text-2" />
          <span className="flex-1">{fr.datePicker.nextMonday}</span>
          <span className="text-[12px] text-text-2">
            {quickHint(quick.nextMonday, clock)}
          </span>
        </button>
      </div>

      <div className="border-t border-border pt-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span id={titleId} className="text-[13px] font-semibold">
            {monthTitle(month)}
          </span>
          <div className="flex gap-0.5">
            <IconButton
              label={fr.datePicker.previousMonth}
              size={26}
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft size={15} aria-hidden />
            </IconButton>
            <IconButton
              label={fr.datePicker.nextMonth}
              size={26}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={15} aria-hidden />
            </IconButton>
          </div>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a group of day buttons, not a data table */}
        <div
          ref={gridRef}
          role="group"
          aria-labelledby={titleId}
          onKeyDown={onGridKey}
          className="grid grid-cols-7 gap-y-0.5"
        >
          {labels.map((l) => (
            <abbr
              key={l.long}
              title={l.long}
              className="pb-1 text-center text-[11.5px] text-text-2 no-underline"
            >
              {l.short}
            </abbr>
          ))}
          {days.map((d) => {
            const selected = d.date === value.date;
            const isToday = d.date === quick.today;
            const label = isToday
              ? `${dayLabel(d.date)}, ${fr.datePicker.isToday}`
              : dayLabel(d.date);
            return (
              <button
                key={d.date}
                type="button"
                data-date={d.date}
                aria-label={label}
                aria-pressed={selected}
                tabIndex={d.date === tabbable ? 0 : -1}
                data-autofocus={selected ? true : undefined}
                onFocus={() => setFocusDay(d.date)}
                onClick={() => pick(d.date)}
                className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-[13px] outline-offset-1 ${
                  selected
                    ? "bg-accent font-semibold text-on-accent"
                    : isToday
                      ? "font-semibold text-accent hover:bg-hover"
                      : d.inMonth
                        ? "text-text hover:bg-hover"
                        : "text-text-3 hover:bg-hover"
                }`}
              >
                {d.day}
              </button>
            );
          })}
        </div>
      </div>

      {!dateOnly && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          <div className="flex items-center gap-1.5">
            <input
              aria-label={fr.datePicker.time}
              aria-describedby={timeHelpId}
              aria-invalid={timeError || undefined}
              placeholder={fr.datePicker.timePlaceholder}
              value={timeText}
              inputMode="numeric"
              onChange={(e) => {
                setTimeText(e.target.value);
                setTimeError(false);
              }}
              onBlur={onTimeBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  commitTime();
                }
              }}
              className={`h-8 min-w-0 flex-1 rounded-md border bg-bg px-2 text-[13.5px] outline-none placeholder:text-text-3 focus:border-accent ${
                timeError ? "border-due-overdue" : "border-border-input"
              }`}
            />
            {value.time !== null && (
              <IconButton
                label={fr.datePicker.clearTime}
                size={28}
                onClick={() => {
                  setTimeText("");
                  setTimeError(false);
                  onChange({ date: value.date, time: null });
                }}
              >
                <X size={14} aria-hidden />
              </IconButton>
            )}
          </div>
          <p
            id={timeHelpId}
            className={`px-0.5 text-[12px] ${timeError ? "text-due-overdue" : "text-text-2"}`}
          >
            {timeError ? fr.datePicker.timeInvalid : fr.datePicker.timeHelp}
          </p>
        </div>
      )}

      {value.date !== null && !dateOnly && (
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            className={`${optionClass} text-text-2`}
            onClick={() => onChange({ date: null, time: null })}
          >
            <X size={15} aria-hidden />
            {fr.datePicker.clear}
          </button>
        </div>
      )}
    </div>
  );
}

/** The picker in a popover under `anchorRef`; `onChange` closes it. */
export function DatePickerPopover({
  anchorRef,
  value,
  onChange,
  onClose,
  now,
  dateOnly,
  label = fr.datePicker.label,
}: DatePickerProps & {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: (restoreFocus: boolean) => void;
  /** Accessible name of the popover (default « Choisir l'échéance »). */
  label?: string;
}) {
  return (
    <Popover anchorRef={anchorRef} label={label} onClose={onClose}>
      <DatePicker
        value={value}
        now={now}
        dateOnly={dateOnly}
        onChange={(v) => {
          onChange(v);
          onClose(true);
        }}
      />
    </Popover>
  );
}
