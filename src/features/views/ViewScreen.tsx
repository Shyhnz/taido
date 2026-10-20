/**
 * Renders the active view from its ViewModel: header (title, subtitle, project
 * ⋯ menu), groups, « Terminées », the new-section field, empty, loading and error states.
 */

import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CalendarDays, Ellipsis, List, Search } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import type { Subject, TaskRow, ViewModel } from "../../bindings";
import { Button } from "../../components/Button";
import { openMenuAt } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { useDay } from "../../lib/clock";
import { formatLongDate } from "../../lib/dates";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { commands, isNotFound } from "../../lib/ipc";
import { useSettings, useSubjects, useView } from "../../lib/queries";
import { run } from "../../lib/run";
import { useLargeScreen } from "../../lib/screen";
import { settingsPatch } from "../../lib/settingsPatch";
import { IS_MOBILE } from "../../lib/target";
import { type ProjectTab, useUi, type VisibleTask } from "../../stores/ui";
import { BoardView } from "../board/BoardView";
import { DashboardView, ProjectStrip } from "../dashboard/DashboardView";
import { dragId } from "../dnd/DndProvider";
import { NotesView } from "../notes/NotesView";
import { PortfolioView } from "../portfolio/PortfolioView";
import { subjectMenuItems } from "../sidebar/subjectActions";
import { groupId } from "./groups";
import { useList } from "./listStore";
import { CompletedGroup, TaskGroupBlock } from "./TaskGroupBlock";
import { UpcomingBar } from "./UpcomingBar";
import { UpcomingCalendar } from "./UpcomingCalendar";
import {
  calendarRange,
  mondayOf,
  monthOf,
  upcomingRange,
} from "./upcomingModel";

/** Delay before the loading skeleton shows, so fast loads never flash (audit B2). */
export const SKELETON_DELAY_MS = 150;

function viewTitle(view: ViewModel): string {
  if (view.kind === "today") return t.sidebar.today;
  if (view.kind === "upcoming") return t.upcoming.title;
  if (view.kind === "all") return t.all.title;
  if (view.kind === "subject") return view.subject?.name ?? "";
  return t.sidebar.noProject;
}

function viewSubtitle(view: ViewModel): string {
  // « Prochainement » has its month and its week strip instead (Todoist).
  if (view.kind === "upcoming") return "";
  return view.kind === "today"
    ? t.views.todaySubtitle(formatLongDate(view.today), view.openCount)
    : t.views.countSubtitle(view.openCount);
}

/** Open rows in display order, subtasks included unless folded (keyboard navigation). */
export function visibleRows(
  rows: TaskRow[],
  completed: boolean,
  collapsed: Record<string, true>,
): VisibleTask[] {
  return rows.flatMap((row) => [
    { id: row.id, completed },
    ...(collapsed[row.id]
      ? []
      : row.children.map((c) => ({
          id: c.id,
          completed: c.completedAt !== null,
        }))),
  ]);
}

/** « Liste | Kanban | Tableau de bord | Notes » under a project's title. */
function ProjectTabs({ notes }: { notes: boolean }) {
  const tab = useUi((s) => s.projectTab);
  const setTab = useUi((s) => s.setProjectTab);
  const tabs: { key: ProjectTab; label: string }[] = [
    { key: "list", label: t.board.list },
    { key: "board", label: t.board.board },
    { key: "dashboard", label: t.dashboard.tab },
    // « Sans projet » has no notebook.
    ...(notes ? [{ key: "notes" as const, label: t.notes.tab }] : []),
  ];
  return (
    <div
      role="tablist"
      aria-label={t.board.tabs}
      className="mt-3 inline-flex max-w-full overflow-x-auto rounded-lg bg-hover p-0.5"
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          // The first-launch guide points at « Kanban ».
          data-tutorial={t.key === "board" ? "board-tab" : undefined}
          onClick={() => setTab(t.key)}
          // A finger needs 44 px on the phone (the web app under 768 px).
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] sm:px-3 ${
            IS_MOBILE ? "h-11 md:h-7" : "h-7"
          } ${
            tab === t.key
              ? "bg-bg font-medium text-text shadow-sm"
              : "text-text-2 hover:text-text"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The project ⋯ menu next to its title (same items as in the sidebar). */
function ProjectMenuButton({ subject }: { subject: Subject }) {
  const subjects = useSubjects().data ?? [];
  return (
    <button
      type="button"
      aria-label={t.sidebar.projectMenu(subject.name)}
      title={t.common.more}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openMenuAt(
          e.currentTarget,
          subjectMenuItems(
            subject,
            { x: rect.left, y: rect.bottom + 4 },
            subjects,
          ),
          t.sidebar.projectMenu(subject.name),
          true,
        );
      }}
      className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
    >
      <Ellipsis size={17} aria-hidden />
    </button>
  );
}

/**
 * « Demander au projet » (Mac only): opens the panel on the
 * right.
 */
function AskButton({ subject }: { subject: Subject }) {
  const open = useUi((s) => s.askSubjectId === subject.id);
  return (
    <button
      type="button"
      aria-pressed={open}
      title={t.ask.button}
      onClick={() => {
        const ui = useUi.getState();
        if (open) ui.closeAsk();
        else ui.openAsk(subject.id);
      }}
      className={`mt-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium ${
        open
          ? "border-accent text-text"
          : "border-border text-text hover:bg-hover"
      }`}
    >
      <Search size={14} aria-hidden />
      <span className="hidden lg:inline">{t.ask.button}</span>
    </button>
  );
}

/** « Liste | Calendrier » of « Prochainement » (2026-10-12), remembered. */
function UpcomingModeSwitch() {
  const mode = useUi((s) => s.upcomingMode);
  const setMode = useUi((s) => s.setUpcomingMode);
  const options = [
    { value: "list", label: t.upcoming.list, Icon: List },
    { value: "calendar", label: t.upcoming.calendar, Icon: CalendarDays },
  ] as const;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a two-button switch, not a fieldset
    <div
      role="group"
      aria-label={t.upcoming.modeLabel}
      className="mt-0.5 flex shrink-0 gap-0.5 rounded-lg border border-border bg-sidebar p-0.5"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          aria-label={label}
          title={label}
          onClick={() => setMode(value)}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium ${
            mode === value
              ? "bg-nav-active text-text"
              : "text-text-2 hover:text-text"
          }`}
        >
          <Icon size={14} aria-hidden />
          {/* A phone keeps the icons only: the title needs the width. */}
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

function ViewHeader({
  view,
  upcomingWeek,
}: {
  view: ViewModel;
  /** « Prochainement »: Monday of the week shown. */
  upcomingWeek?: string;
}) {
  const upcomingMode = useUi((s) => s.upcomingMode);
  const upcomingMonth = useUi((s) => s.upcomingMonth);
  const subtitle = viewSubtitle(view);
  const subject = view.kind === "subject" ? view.subject : null;
  const title = (
    <header className="flex items-start gap-3 pt-10 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-2.5 text-title leading-8 font-bold">
          {subject && (
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ background: subjectColorVar(subject.color) }}
            />
          )}
          <span className="truncate">{viewTitle(view)}</span>
        </h1>
        {subtitle && (
          <p className="mt-0.5 truncate text-[13px] text-text-2">{subtitle}</p>
        )}
        {(subject || view.kind === "inbox") && (
          <ProjectTabs notes={subject !== null} />
        )}
      </div>
      {subject && features.ask && <AskButton subject={subject} />}
      {subject && <ProjectMenuButton subject={subject} />}
      {view.kind === "upcoming" && <UpcomingModeSwitch />}
    </header>
  );
  if (view.kind !== "upcoming" || upcomingWeek === undefined) return title;
  return (
    <>
      {title}
      {upcomingMode === "calendar" ? (
        <UpcomingCalendar
          month={upcomingMonth ?? monthOf(view.today)}
          view={view}
        />
      ) : (
        <UpcomingBar monday={upcomingWeek} today={view.today} view={view} />
      )}
    </>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-10 text-center">
      <p className="text-[15px] font-semibold">{title}</p>
      <p className="max-w-[340px] text-[13.5px] text-text-2">{text}</p>
    </div>
  );
}

/** Three gray lines, shown only when loading takes more than 150 ms. */
function Skeleton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label={t.list.loading}
      className={`pt-10 ${visible ? "" : "invisible"}`}
    >
      <div className="mb-6 h-7 w-48 rounded-md bg-hover" />
      {[72, 56, 64].map((w) => (
        <div key={w} className="flex h-[38px] items-center gap-2.5 px-2">
          <span className="h-5 w-5 rounded-full border-[1.6px] border-border" />
          <span className="h-3 rounded bg-hover" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 pt-28">
      <p className="text-[14px] text-text-2">{t.views.loadError}</p>
      <Button onClick={onRetry}>{t.list.retry}</Button>
    </div>
  );
}

/** « Ajouter une section » field, opened from the project ⋯ menu. */
function AddSection({ subjectId }: { subjectId: string }) {
  const close = useList((s) => s.closeSectionDraft);
  const [name, setName] = useState("");
  const [subpath, setSubpath] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length === 0) return;
    const section = await run(
      commands.createSection({
        subjectId,
        name: name.trim(),
        subpath: subpath.trim() ? subpath.trim() : null,
      }),
      t.errors.action.createSection,
    );
    if (section) close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className="mt-6 flex flex-col gap-2"
    >
      <div className="flex gap-2">
        <input
          // biome-ignore lint/a11y/noAutofocus: opened on an explicit user action
          autoFocus
          aria-label={t.section.nameLabel}
          placeholder={t.section.namePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-border-input bg-bg px-2.5 text-[14px] font-semibold"
        />
        {features.terminals && (
          <input
            aria-label={t.section.subpathLabel}
            placeholder={t.section.subpathLabel}
            value={subpath}
            onChange={(e) => setSubpath(e.target.value)}
            className="h-9 w-[220px] rounded-md border border-border-input bg-bg px-2.5 font-mono text-[12.5px]"
          />
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!name.trim()}
        >
          {t.section.add}
        </Button>
        <Button size="sm" onClick={close}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

function ViewBody({
  view,
  upcomingWeek,
}: {
  view: ViewModel;
  upcomingWeek?: string;
}) {
  const showCompleted = useSettings().data?.showCompleted ?? false;
  const projectTab = useUi((s) => s.projectTab);
  const upcomingMode = useUi((s) => s.upcomingMode);
  const sectionDraft = useList(
    (s) => view.subject !== null && s.sectionDraftFor === view.subject.id,
  );

  // The « Terminées » fold remembers its state (it replaces the old « Affichage » menu).
  const toggleCompleted = () => {
    void run(
      commands.updateSettings(settingsPatch({ showCompleted: !showCompleted })),
      t.errors.action.settings,
    );
  };

  const calendar = view.kind === "upcoming" && upcomingMode === "calendar";
  const visibleGroups = view.groups.filter(
    (g) =>
      // « Prochainement »: the days already past have no section (the core sends them empty).
      !(g.key.type === "day" && g.key.date < view.today) &&
      (g.tasks.length > 0 || g.addTarget !== null || g.key.type === "section"),
  );
  const groups = visibleGroups.map((group) => (
    <TaskGroupBlock
      key={JSON.stringify(group.key)}
      group={group}
      viewKind={view.kind}
      subject={view.subject}
    />
  ));
  const noSections = (view.subject?.sections.length ?? 0) === 0;
  // « Prochainement » always shows its days, each with its add row.
  const empty =
    view.kind !== "upcoming" &&
    view.openCount === 0 &&
    (view.kind !== "subject" || noSections);
  const [emptyTitle, emptyText] =
    view.kind === "today"
      ? [t.views.empty.todayTitle, t.views.empty.todayText]
      : view.kind === "subject"
        ? [t.views.empty.subjectTitle, t.views.empty.subjectText]
        : view.kind === "all"
          ? [t.all.emptyTitle, t.all.emptyText]
          : [t.views.empty.noProjectTitle, t.views.empty.noProjectText];

  const hasBoard = view.kind === "subject" || view.kind === "inbox";
  if (hasBoard && projectTab === "board") {
    return (
      <div>
        <ViewHeader view={view} upcomingWeek={upcomingWeek} />
        <BoardView
          key={view.subject?.id ?? "inbox"}
          subjectId={view.subject?.id ?? null}
        />
      </div>
    );
  }
  if (hasBoard && projectTab === "dashboard") {
    return (
      <div>
        <ViewHeader view={view} upcomingWeek={upcomingWeek} />
        <DashboardView subjectId={view.subject?.id ?? null} />
      </div>
    );
  }

  if (view.kind === "subject" && view.subject && projectTab === "notes") {
    return (
      <div>
        <ViewHeader view={view} upcomingWeek={upcomingWeek} />
        <NotesView key={view.subject.id} subjectId={view.subject.id} />
      </div>
    );
  }

  // « Prochainement » as a calendar: the month grid (in the header) holds the tasks.
  if (calendar) {
    return (
      <div className="pb-24">
        <ViewHeader view={view} upcomingWeek={upcomingWeek} />
      </div>
    );
  }

  return (
    <div className="pb-24">
      <ViewHeader view={view} upcomingWeek={upcomingWeek} />
      {hasBoard && <ProjectStrip subjectId={view.subject?.id ?? null} />}
      {view.kind === "all" ? (
        // « À faire »: the project groups are sortable by their header. One context for both
        // levels: during a drag the preview may shift sub-project groups too; after the drop
        // the core keeps them after their parent.
        <SortableContext
          items={visibleGroups
            .filter((g) => g.order)
            .map((g) => dragId.projectGroup(groupId(g.key)))}
          strategy={verticalListSortingStrategy}
        >
          {groups}
        </SortableContext>
      ) : (
        groups
      )}
      {empty && <EmptyState title={emptyTitle} text={emptyText} />}
      {sectionDraft && view.subject && (
        <AddSection subjectId={view.subject.id} />
      )}
      <CompletedGroup
        rows={view.completed}
        expanded={showCompleted}
        onToggle={toggleCompleted}
      />
    </div>
  );
}

export function ViewScreen() {
  const active = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setVisibleTasks = useUi((s) => s.setVisibleTasks);
  const showCompleted = useSettings().data?.showCompleted ?? false;
  const collapsed = useUi((s) => s.collapsedTasks);
  const day = useDay((s) => s.day);
  const chosenWeek = useUi((s) => s.upcomingWeek);
  const upcomingMode = useUi((s) => s.upcomingMode);
  const chosenMonth = useUi((s) => s.upcomingMonth);
  // « Prochainement »: the week chosen with ‹ › or the month picker, else this week.
  const upcomingWeek =
    active.kind === "upcoming" ? (chosenWeek ?? mondayOf(day)) : undefined;
  const {
    data: view,
    error,
    refetch,
  } = useView(
    active.kind,
    active.subjectId,
    upcomingWeek
      ? upcomingMode === "calendar"
        ? calendarRange(chosenMonth ?? monthOf(day))
        : upcomingRange(upcomingWeek, day)
      : null,
  );
  const gone = error !== null && active.kind === "subject" && isNotFound(error);
  // The portfolio needs a large screen; a web window narrowed under 1024 px
  // leaves it for « À faire », the first view of the sidebar.
  const largeScreen = useLargeScreen();
  const portfolioOff = active.kind === "portfolio" && !largeScreen;
  useEffect(() => {
    if (portfolioOff) setView({ kind: "all", subjectId: null });
  }, [portfolioOff, setView]);

  // A deleted project: say so and go back to Today (audit B2).
  useEffect(() => {
    if (!gone) return;
    showToast({ message: t.views.unknownSubject });
    setView({ kind: "today", subjectId: null });
  }, [gone, setView]);

  // The keyboard (↑/↓, Enter, ⌘Enter) walks the rows in display order.
  useEffect(() => {
    if (!view) return;
    const open = view.groups.flatMap((g) =>
      visibleRows(g.tasks, false, collapsed),
    );
    const done = showCompleted
      ? visibleRows(view.completed, true, collapsed)
      : [];
    setVisibleTasks([...open, ...done]);
  }, [view, showCompleted, collapsed, setVisibleTasks]);

  let body: ReactNode;
  if (portfolioOff) {
    body = <Skeleton />;
  } else if (active.kind === "portfolio") {
    // The portfolio reads its own model.
    body = <PortfolioView />;
  } else if (view) {
    // First launch is handled by the shell (features/first-launch).
    body = <ViewBody view={view} upcomingWeek={upcomingWeek} />;
  } else if (error && !gone) {
    body = <ErrorBlock onRetry={() => void refetch()} />;
  } else {
    body = <Skeleton />;
  }

  // Announcements go to the global live region mounted by the shell.
  return body;
}
