/**
 * « Prochainement » (Todoist's Upcoming): sidebar entry and ⌘2, month
 * button, week strip with ‹ Aujourd'hui ›, one section per day with its add row prefilling
 * the day, overdue tasks first with « Reporter à aujourd'hui ».
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { todayString } from "../../lib/dates";
import { mockBackend } from "../../lib/ipc";
import { resetUi, UPCOMING_MODE_KEY, useUi } from "../../stores/ui";
import { useCompletion } from "../task-row/actions";
import { resetList } from "./listStore";
import { scrollToDay } from "./UpcomingBar";
import {
  calendarDays,
  calendarRange,
  dayTitle,
  mondayOf,
  monthLabel,
  monthOf,
  shiftDays,
  shiftMonths,
  shortDate,
  upcomingRange,
  weekDays,
  weekdayName,
} from "./upcomingModel";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const main = () => screen.getByRole("main");
const today = () => todayString();

const task = (title: string, dueDate: string | null) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate,
    dueTime: null,
  });

const daySection = (date: string) =>
  main().querySelector<HTMLElement>(`[data-group="day:${date}"]`);

const realMatchMedia = window.matchMedia;

/** A screen at least `sm` wide: the calendar cells show their tasks. */
function wideScreen() {
  window.matchMedia = (query: string) =>
    ({
      ...realMatchMedia(query),
      matches: query === "(min-width: 640px)",
    }) as MediaQueryList;
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

beforeEach(async () => {
  backend().reset({ seed: false });
  resetUi();
  resetList();
  useCompletion.setState({ phases: {} });
  useToasts.setState({ toasts: [] });
  // A project, so the app shows its views rather than the first-launch screen.
  await backend().commands.createSubject({
    name: "Perso",
    color: null,
    rootPath: null,
    parentId: null,
  });
});

describe("upcoming model", () => {
  it("titles days like the screenshot", () => {
    const now = new Date(2026, 9, 3, 10, 0);
    expect(dayTitle("2026-10-03", now)).toBe("3 oct · Aujourd'hui · Samedi");
    expect(dayTitle("2026-10-04", now)).toBe("4 oct · Demain · Dimanche");
    expect(dayTitle("2026-10-05", now)).toBe("5 oct · Lundi");
    expect(mondayOf("2026-10-03")).toBe("2026-09-28");
    expect(weekDays("2026-09-28").at(-1)).toBe("2026-10-04");
    expect(monthLabel("2026-10-03")).toBe("Octobre 2026");
  });

  it("always lists a week ahead", () => {
    // Saturday: Monday 28 to next Friday 9.
    expect(upcomingRange("2026-09-28", "2026-10-03")).toEqual({
      from: "2026-09-28",
      days: 12,
    });
    expect(upcomingRange("2026-10-05", "2026-10-03")).toEqual({
      from: "2026-10-05",
      days: 7,
    });
  });
});

describe("« Prochainement »", () => {
  it("opens from the sidebar with its month, its week strip and one section per day", async () => {
    const user = userEvent.setup();
    const t = today();
    await task("Rendre le devis", shiftDays(t, 1));
    await task("Aujourd'hui même", t);
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Prochainement" }),
    );
    expect(useUi.getState().view.kind).toBe("upcoming");
    const m = main();
    expect(
      await within(m).findByRole("heading", {
        level: 1,
        name: "Prochainement",
      }),
    ).toBeInTheDocument();
    // The month of the first day shown (today).
    expect(
      within(m).getByRole("button", {
        name: `${monthLabel(t)}, choisir une date`,
      }),
    ).toHaveTextContent(monthLabel(t));
    // Seven days, Monday first; today in the accent pill, past days inert.
    const strip = within(m).getByRole("group", { name: "Jours de la semaine" });
    const days = within(strip).getAllByRole("button");
    expect(days.map((d) => d.dataset.day)).toEqual(weekDays(mondayOf(t)));
    const todayButton = days.find((d) => d.dataset.day === t);
    expect(todayButton).toHaveAttribute("aria-current", "date");
    expect(todayButton?.querySelector(".bg-accent")).not.toBeNull();
    expect(m.querySelector(".bg-waiting")).toBeNull();
    for (const d of days) {
      if ((d.dataset.day ?? "") < t) expect(d).toBeDisabled();
    }
    // Today's and tomorrow's sections, titled like Todoist.
    const first = await waitFor(() => {
      const el = daySection(t);
      if (!el) throw new Error("no section yet");
      return el;
    });
    expect(within(first).getByRole("heading", { level: 2 })).toHaveTextContent(
      `${shortDate(t)} · Aujourd'hui · ${weekdayName(t)}`,
    );
    expect(within(first).getByText("Aujourd'hui même")).toBeInTheDocument();
    const tomorrow = daySection(shiftDays(t, 1));
    expect(tomorrow).not.toBeNull();
    expect(
      within(tomorrow as HTMLElement).getByRole("heading", { level: 2 }),
    ).toHaveTextContent(" · Demain · ");
    expect(
      within(tomorrow as HTMLElement).getByText("Rendre le devis"),
    ).toBeInTheDocument();
    // Days before today show no section.
    if (mondayOf(t) < t) expect(daySection(mondayOf(t))).toBeNull();
  });

  it("opens with ⌘3", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Prochainement" });
    await user.keyboard("{Meta>}3{/Meta}");
    expect(
      await within(main()).findByRole("heading", {
        level: 1,
        name: "Prochainement",
      }),
    ).toBeInTheDocument();
  });

  it("adds a task to a day from its add row, prefilled with that day", async () => {
    const user = userEvent.setup();
    const day = shiftDays(today(), 2);
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    const empty = await waitFor(() => {
      const el = daySection(day);
      if (!el) throw new Error("no section yet");
      return el;
    });
    // An empty day is one line: « Rien de prévu » and its « + ».
    expect(empty).toHaveAttribute("data-empty-day");
    expect(within(empty).getByText("Rien de prévu")).toBeInTheDocument();
    await user.click(
      within(empty).getByRole("button", { name: /^Ajouter une tâche : / }),
    );
    const section = daySection(day) as HTMLElement;
    expect(section).not.toHaveAttribute("data-empty-day");
    const editor = section.querySelector<HTMLElement>("[data-task-editor]");
    expect(editor).not.toBeNull();
    // The due chip says the day (a weekday within the week).
    expect(
      within(editor as HTMLElement).getByRole("button", {
        name: /^Échéance : /,
      }),
    ).toHaveTextContent(weekdayName(day));
    await user.type(
      within(editor as HTMLElement).getByRole("textbox", {
        name: "Nom de la tâche",
      }),
      "Appeler Paul{Enter}",
    );
    await waitFor(() =>
      expect(within(section).getByText("Appeler Paul")).toBeInTheDocument(),
    );
    const view = await backend().commands.getView({
      kind: "upcoming",
      subjectId: null,
      from: null,
      days: null,
    });
    const group = view.groups.find(
      (g) => g.key.type === "day" && g.key.date === day,
    );
    expect(group?.tasks.map((x) => x.due?.date)).toEqual([day]);
  });

  it("moves by week with ‹ Aujourd'hui ›", async () => {
    const user = userEvent.setup();
    const t = today();
    const nextMonday = shiftDays(mondayOf(t), 7);
    await task("La semaine prochaine", shiftDays(nextMonday, 2));
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    const previous = await within(main()).findByRole("button", {
      name: "Semaine précédente",
    });
    // Nothing before this week.
    expect(previous).toBeDisabled();
    await user.click(
      within(main()).getByRole("button", { name: "Semaine suivante" }),
    );
    expect(useUi.getState().upcomingWeek).toBe(nextMonday);
    const strip = within(main()).getByRole("group", {
      name: "Jours de la semaine",
    });
    await waitFor(() =>
      expect(within(strip).getAllByRole("button")[0].dataset.day).toBe(
        nextMonday,
      ),
    );
    expect(
      await within(main()).findByText("La semaine prochaine"),
    ).toBeInTheDocument();
    expect(previous).toBeEnabled();
    await user.click(
      within(main()).getByRole("button", { name: "Aujourd'hui" }),
    );
    expect(useUi.getState().upcomingWeek).toBeNull();
    await waitFor(() =>
      expect(within(strip).getAllByRole("button")[0].dataset.day).toBe(
        mondayOf(t),
      ),
    );
  });

  it("jumps to a day's week from the month button", async () => {
    const user = userEvent.setup();
    const t = today();
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: /choisir une date$/ }),
    );
    const picker = await screen.findByRole("dialog", {
      name: /choisir une date$/,
    });
    // A day only: no time field, no « Retirer ».
    expect(within(picker).queryByRole("textbox", { name: "Heure" })).toBeNull();
    await user.click(
      within(picker).getByRole("button", { name: "Mois suivant" }),
    );
    const target = within(picker)
      .getAllByRole("button")
      .find((b) => b.dataset.date?.endsWith("-15") === true);
    expect(target).toBeDefined();
    await user.click(target as HTMLElement);
    const date = target?.dataset.date ?? "";
    expect(useUi.getState().upcomingWeek).toBe(mondayOf(date));
    expect(date > t).toBe(true);
  });

  it("scrolls to the chosen day once its week has rendered", async () => {
    // jsdom has no scrollIntoView: record which group asks for it.
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.group ?? "");
    };
    try {
      const user = userEvent.setup();
      useUi.getState().setView({ kind: "upcoming", subjectId: null });
      render(<App />);
      await user.click(
        await within(main()).findByRole("button", {
          name: /choisir une date$/,
        }),
      );
      const picker = await screen.findByRole("dialog", {
        name: /choisir une date$/,
      });
      await user.click(
        within(picker).getByRole("button", { name: "Mois suivant" }),
      );
      const target = within(picker)
        .getAllByRole("button")
        .find((b) => b.dataset.date?.endsWith("-15") === true);
      await user.click(target as HTMLElement);
      const date = target?.dataset.date ?? "";
      await waitFor(() => expect(daySection(date)).not.toBeNull());
      expect(scrolled).toEqual([`day:${date}`]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("forgets a day not reached when the view or the week changes", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.group ?? "");
    };
    try {
      const t = today();
      const nextMonday = shiftDays(mondayOf(t), 7);
      const user = userEvent.setup();
      useUi.getState().setView({ kind: "inbox", subjectId: null });
      render(<App />);
      // Asked from elsewhere, then « Prochainement » left before the day showed.
      act(() => scrollToDay(nextMonday));
      act(() => useUi.getState().setView({ kind: "today", subjectId: null }));
      act(() => {
        useUi.getState().setUpcomingWeek(nextMonday);
        useUi.getState().setView({ kind: "upcoming", subjectId: null });
      });
      await waitFor(() => expect(daySection(nextMonday)).not.toBeNull());
      // A week change that is not the jump itself drops it too.
      const later = shiftDays(nextMonday, 28);
      act(() => scrollToDay(later));
      await user.click(
        within(main()).getByRole("button", { name: "Semaine suivante" }),
      );
      await waitFor(() =>
        expect(daySection(shiftDays(nextMonday, 7))).not.toBeNull(),
      );
      // Its week shown later: no jump. The only scroll was the button's own (its Monday).
      act(() => useUi.getState().setUpcomingWeek(mondayOf(later)));
      await waitFor(() => expect(daySection(later)).not.toBeNull());
      expect(scrolled).toEqual([`day:${shiftDays(nextMonday, 7)}`]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("a jump to a day not rendered yet leaves no timer running", () => {
    // A timer outliving the screen (and the test) touched `document` after teardown.
    vi.useFakeTimers();
    try {
      scrollToDay(shiftDays(today(), 60));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes to the current week when the month button picks a past day", async () => {
    const user = userEvent.setup();
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    useUi.getState().setUpcomingWeek(shiftDays(mondayOf(today()), 7));
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: /choisir une date$/ }),
    );
    const picker = await screen.findByRole("dialog", {
      name: /choisir une date$/,
    });
    for (let i = 0; i < 2; i++) {
      await user.click(
        within(picker).getByRole("button", { name: "Mois précédent" }),
      );
    }
    const past = within(picker)
      .getAllByRole("button")
      .find((b) => b.dataset.date?.endsWith("-15") === true);
    expect(past?.dataset.date && past.dataset.date < today()).toBe(true);
    await user.click(past as HTMLElement);
    // Today's week (`null`), never a week of past days only.
    expect(useUi.getState().upcomingWeek).toBeNull();
  });

  it("puts overdue tasks first, with « Reporter à aujourd'hui »", async () => {
    const user = userEvent.setup();
    const t = today();
    await task("Oubliée", shiftDays(t, -3));
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    const overdue = await within(main()).findByRole("region", {
      name: "En retard",
    });
    expect(within(overdue).getByText("Oubliée")).toBeInTheDocument();
    const sections = Array.from(main().querySelectorAll("[data-group]")).map(
      (el) => el.getAttribute("data-group"),
    );
    expect(sections[0]).toBe("today_overdue");
    await user.click(
      within(overdue).getByRole("button", { name: "Reporter à aujourd'hui" }),
    );
    await waitFor(() =>
      expect(
        within(daySection(t) as HTMLElement).getByText("Oubliée"),
      ).toBeInTheDocument(),
    );
  });

  it("shows a month calendar, remembered, whose tasks open and whose days lead to the list", async () => {
    const user = userEvent.setup();
    const t = today();
    const month = monthOf(t);
    const days = calendarDays(month);
    const late = shiftDays(t, -1);
    await task("Aujourd'hui A", t);
    await task("Aujourd'hui B", t);
    await task("Aujourd'hui C", t);
    if (days.includes(late)) await task("Oubliée", late);
    wideScreen();
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    await user.click(
      await within(main()).findByRole("button", { name: "Calendrier" }),
    );
    expect(useUi.getState().upcomingMode).toBe("calendar");
    expect(window.localStorage.getItem(UPCOMING_MODE_KEY)).toBe("calendar");
    const grid = await waitFor(() => {
      const el = main().querySelector<HTMLElement>(
        `[data-calendar="${month}"]`,
      );
      if (!el) throw new Error("no calendar yet");
      return el;
    });
    const cell = await waitFor(() => {
      const el = grid.querySelector<HTMLElement>(`[data-day="${t}"]`);
      if (!el || !within(el).queryByText("Aujourd'hui A"))
        throw new Error("no tasks yet");
      return el;
    });
    // Two tasks, then « + 1 autre ».
    expect(within(cell).queryByText("Aujourd'hui C")).toBeNull();
    expect(within(cell).getByText("+ 1 autre")).toBeInTheDocument();
    if (days.includes(late)) {
      const lateCell = grid.querySelector(
        `[data-day="${late}"]`,
      ) as HTMLElement;
      expect(
        within(lateCell).getByRole("button", { name: "Oubliée, en retard" }),
      ).toBeInTheDocument();
    }
    // A task opens its panel.
    await user.click(within(cell).getByText("Aujourd'hui A"));
    const opened = useUi.getState().openTaskId;
    expect(opened).not.toBeNull();
    useUi.getState().openTask(null);
    // The day's number goes to that day in the list.
    await user.click(
      within(grid.querySelector(`[data-day="${t}"]`) as HTMLElement).getByRole(
        "button",
        { name: /voir la liste$/ },
      ),
    );
    expect(useUi.getState().upcomingMode).toBe("list");
    await waitFor(() => expect(daySection(t)).not.toBeNull());
  });
});

describe("calendar on a phone", () => {
  it("selects a day with a tap and lists its tasks under the grid", async () => {
    const user = userEvent.setup();
    const t = today();
    const month = monthOf(t);
    const other = calendarDays(month).find(
      (d) => d > t && d.startsWith(month.slice(0, 7)),
    );
    await task("Ce jour", t);
    if (other) await task("Plus tard", other);
    useUi.setState({ upcomingMode: "calendar" });
    useUi.getState().setView({ kind: "upcoming", subjectId: null });
    render(<App />);
    // Today is selected: its task shows under the grid, as a large draggable button.
    const panel = await waitFor(() => {
      const el = main().querySelector<HTMLElement>(
        `[data-selected-day="${t}"]`,
      );
      if (!el || !within(el).queryByText("Ce jour")) throw new Error("not yet");
      return el;
    });
    expect(
      within(panel).getByRole("button", { name: /Ce jour/ }),
    ).toHaveAttribute("aria-roledescription");
    // The cells show dots, not titles.
    const grid = main().querySelector(
      `[data-calendar="${month}"]`,
    ) as HTMLElement;
    expect(within(grid).queryByText("Ce jour")).toBeNull();
    if (other) {
      await user.click(
        (
          grid.querySelector(`[data-day="${other}"]`) as HTMLElement
        ).querySelector("button") as HTMLElement,
      );
      const next = main().querySelector(
        `[data-selected-day="${other}"]`,
      ) as HTMLElement;
      expect(within(next).getByText("Plus tard")).toBeInTheDocument();
    }
    await user.click(
      within(main()).getByRole("button", { name: "Voir dans la liste" }),
    );
    expect(useUi.getState().upcomingMode).toBe("list");
  });
});

describe("calendar model", () => {
  it("covers whole weeks of the month, Monday first", () => {
    // October 2026: Thursday 1 to Saturday 31 → Monday 28 Sept to Sunday 1 Nov.
    const oct = calendarDays("2026-10-01");
    expect(oct[0]).toBe("2026-09-28");
    expect(oct.at(-1)).toBe("2026-11-01");
    expect(oct).toHaveLength(35);
    // March 2027 starts on a Monday and needs 5 weeks; August 2027 needs 6.
    expect(calendarDays("2027-03-01")[0]).toBe("2027-03-01");
    expect(calendarDays("2027-08-01")).toHaveLength(42);
    expect(calendarRange("2026-10-01")).toEqual({
      from: "2026-09-28",
      days: 35,
    });
    expect(monthOf("2026-10-14")).toBe("2026-10-01");
    expect(shiftMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftMonths("2026-01-01", -1)).toBe("2025-12-01");
  });
});
