/**
 * Sidebar: header (« Todo », Réglages), « Nouvelle tâche »,
 * « Recherche » (⌘K), « Aujourd'hui », « Prochainement » and « À faire »
 *, the transverse views, « Projets » with one row per project (sub-projects
 * indented under their parent, foldable with a remembered chevron), the
 * permanent « + Nouveau projet » line that becomes an input in place, and the « Sans projet »
 * line shown only when at least one task has no project. « Sans projet » sits among the
 * top-level projects at its stored place (synced) and is dragged or moved with ⌥↑ / ⌥↓ like
 * them, but has no menu: it is never renamed nor deleted. The footer stays empty.
 *
 * The « Synchroniser » button left of Réglages (hidden until an account is
 * linked); drag and drop only with `features.dragAndDrop` and shortcut hints only with
 * `features.shortcuts` (both off on the phone; the Mac is unchanged).
 *
 * With no project yet, the list is a dashed « + Crée ton premier projet » line. While the
 * projects load, a skeleton shows after 150 ms; on error, a « Réessayer » line (audit B2).
 *
 * Active item (bug B1): left accent bar + `--bg-nav-active` + medium weight, applied without
 * any transition; hover uses its own token and only on devices that can hover.
 */

import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BriefcaseBusiness,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Inbox,
  ListTodo,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Subject, SubjectColor, SubjectDot } from "../../bindings";
import { Button, IconButton } from "../../components/Button";
import { openContextMenu, openMenuAt } from "../../components/Menu";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import {
  useCounts,
  useHasNoProjectTasks,
  useInboxIndex,
  useSubjects,
} from "../../lib/queries";
import { useLargeScreen } from "../../lib/screen";
import { type ActiveView, useUi } from "../../stores/ui";
import { type DragData, dragId } from "../dnd/DndProvider";
import { isTouchContextMenu } from "../dnd/sensors";
import { SyncButton } from "../sync";
import { openAddTaskForView } from "../views/addTarget";
import {
  groupMenuItems,
  projectGroupItems,
  useProjectSelection,
} from "./groupActions";
import {
  createProject,
  INBOX_FOCUS_ID,
  moveInboxBy,
  moveSubjectBy,
  nextProjectColor,
  saveSubjectName,
  subjectMenuItems,
  subProjectsOf,
  useProjectFocus,
  useProjectRename,
} from "./subjectActions";
import { topLevelItems } from "./topLevel";

const DOT_COLOR: Record<SubjectDot, string> = {
  waiting: "var(--state-waiting)",
  error: "var(--state-crashed)",
  done: "var(--state-done)",
};

/** « Label (⌘K) » where keyboard shortcuts exist, else the label alone (the phone). */
export function withShortcut(label: string, keys: string): string {
  return features.shortcuts ? `${label} (${keys})` : label;
}

/** Delay before the projects skeleton shows, so a fast load never flashes it (audit B2). */
export const SKELETON_DELAY_MS = 150;

/** True when `item` is the view shown in the main area. */
export function isActiveView(view: ActiveView, item: ActiveView): boolean {
  return (
    view.kind === item.kind &&
    (item.kind !== "subject" || view.subjectId === item.subjectId)
  );
}

/**
 * Classes of a navigation row. The active state has no transition (B1): the highlight moves
 * in the same frame as the click or the shortcut.
 */
export function navRowClass(active: boolean, muted = false): string {
  return `nav-row relative flex h-[34px] w-full items-center rounded-md text-left text-body ${
    active
      ? "nav-row-active bg-nav-active font-medium text-text-nav-active"
      : muted
        ? "text-text-2"
        : "text-text"
  }`;
}

function NavButton({
  item,
  label,
  icon,
  count,
  waiting = 0,
  title,
  muted = false,
  shortcut,
  buttonRef,
  onKeyDown,
}: {
  item: ActiveView;
  label: string;
  icon: ReactNode;
  count: number;
  /** Shortcut shown at the right like « Recherche ⌘K ». */
  shortcut?: string;
  /** Red counter of the tasks where Claude waits. */
  waiting?: number;
  title?: string;
  /** Grey row (« Sans projet »). */
  muted?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const agent = useDefaultAgent();
  const active = useUi((s) => isActiveView(s.view, item));
  const setView = useUi((s) => s.setView);
  return (
    <button
      ref={buttonRef}
      type="button"
      data-nav-item
      aria-current={active ? "page" : undefined}
      title={title}
      onClick={() => setView(item)}
      onKeyDown={onKeyDown}
      className={`${navRowClass(active, muted)} gap-2.5 px-2`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {waiting > 0 && (
        <span
          data-waiting-count
          title={t.sidebar.waitingCount(waiting, agent)}
          className="min-w-[18px] rounded-full bg-waiting px-1.5 text-center text-[11.5px] leading-[18px] font-semibold text-on-waiting tabular-nums"
        >
          <span aria-hidden="true">{waiting}</span>
          <span className="sr-only">
            {t.sidebar.waitingCount(waiting, agent)}
          </span>
        </span>
      )}
      {count > 0 && (
        <span
          className={`text-[12px] ${active ? "" : "text-text-2"} font-normal`}
        >
          {count}
        </span>
      )}
      {shortcut && features.shortcuts && (
        <span
          aria-hidden="true"
          className="font-sans text-[12px] font-normal text-text-3"
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}

function Pastille({ color }: { color: SubjectColor }) {
  return (
    <span className="flex w-[18px] shrink-0 justify-center">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full"
        style={{ background: subjectColorVar(color) }}
      />
    </span>
  );
}

/**
 * A project name edited in place (new project, rename). Enter commits, Escape cancels, leaving
 * the field commits too (an empty field cancels). `onCommit` resolves to false to keep the
 * field open (e.g. the command failed).
 */
export function InlineNameInput({
  color,
  label,
  initial = "",
  placeholder,
  hint,
  focusKey,
  onCommit,
  onCancel,
}: {
  /** The project's colour dot; none for a name without colour (a notebook group). */
  color?: SubjectColor;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  /** Changing it gives the focus back to the field. */
  focusKey?: number;
  onCommit: (name: string, fromBlur: boolean) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Set once the field is committed or cancelled: the blur that follows is ignored.
  const settled = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the trigger
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [focusKey]);

  const commit = async (fromBlur: boolean) => {
    if (settled.current) return;
    if (value.trim().length === 0) {
      settled.current = true;
      onCancel();
      return;
    }
    settled.current = true;
    const ok = await onCommit(value, fromBlur);
    if (!ok) settled.current = false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void commit(false);
    } else if (e.key === "Escape") {
      // Handled here: the global shortcut handler skips prevented events.
      e.preventDefault();
      e.stopPropagation();
      settled.current = true;
      onCancel();
    }
  };

  return (
    <div>
      <div className="flex h-[34px] items-center gap-2.5 rounded-md bg-bg px-2 ring-2 ring-accent">
        {color && <Pastille color={color} />}
        <input
          ref={ref}
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void commit(true)}
          className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-3"
        />
      </div>
      {hint && (
        <p className="pt-1 pb-1 pl-[36px] text-meta text-text-3">{hint}</p>
      )}
    </div>
  );
}

/**
 * Chevron of a parent project: shown on hover or focus, and
 * always while the sub-projects are folded so they are never lost from sight.
 */
function SubProjectsToggle({ subject }: { subject: Subject }) {
  const open = useUi((s) => s.collapsedProjects[subject.id] !== true);
  const toggle = useUi((s) => s.toggleSubProjects);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <IconButton
      label={
        open
          ? t.subProjects.hide(subject.name)
          : t.subProjects.show(subject.name)
      }
      size={20}
      aria-expanded={open}
      data-subprojects-toggle
      className={`absolute right-[32px] ${
        open
          ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          : ""
      }`}
      onClick={() => toggle(subject.id)}
    >
      <Chevron size={14} aria-hidden />
    </IconButton>
  );
}

function SubjectRow({
  subject,
  index,
  count,
  subjects,
  subProjects = [],
  hiddenIndex = null,
  children,
}: {
  subject: Subject;
  /**
   * Index in its level: the top-level order (« Sans projet » counted, even hidden), or its
   * parent's sub-projects.
   */
  index: number;
  /** Number of items of its level, for ⌥↓ on the last one. */
  count: number;
  /** Top level: the slot of « Sans projet » while the sidebar hides it (⌥↑ / ⌥↓ skip it). */
  hiddenIndex?: number | null;
  /** Every project (flat), for the ⋯ menu (« Déplacer vers… », folders). */
  subjects: Subject[];
  /** The sub-projects of a parent (they get a fold chevron). */
  subProjects?: Subject[];
  /** Sub-projects block, dragged along with its parent. */
  children?: ReactNode;
}) {
  const agent = useDefaultAgent();
  const isActive = useUi(
    (s) => s.view.kind === "subject" && s.view.subjectId === subject.id,
  );
  const setView = useUi((s) => s.setView);
  const renaming = useProjectRename((s) => s.renamingId === subject.id);
  const stopRename = useProjectRename((s) => s.stop);
  const data: DragData = {
    type: "subject",
    subjectId: subject.id,
    name: subject.name,
    index,
    parentId: subject.parentId,
  };
  const isParent = subProjects.length > 0;
  const folded = useUi((s) => s.collapsedProjects[subject.id] === true);
  const {
    setNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
    active: dragActive,
  } = useSortable({
    id: dragId.subject(subject.id),
    data,
    disabled: renaming || !features.dragAndDrop,
  });
  // Pointer drag (mouse, or a long press on a touch screen) only: the keyboard listener would
  // hijack Enter on the inner button.
  // The keyboard reorders with ⌥↑ / ⌥↓ instead (`onNavKeyDown`).
  const { onKeyDown: _keyboardDrag, ...pointerListeners } = listeners ?? {};
  const navRef = useRef<HTMLButtonElement>(null);
  const focusMe = useProjectFocus((s) => s.focusId === subject.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` changes when the moved row lands at its new place
  useEffect(() => {
    if (!focusMe) return;
    navRef.current?.focus();
    useProjectFocus.setState({ focusId: null });
  }, [focusMe, index]);
  const onNavKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    void moveSubjectBy(
      subject,
      index,
      count,
      e.key === "ArrowUp" ? -1 : 1,
      hiddenIndex,
    );
  };
  const taskOver =
    isOver &&
    (dragActive?.data.current as DragData | undefined)?.type === "task";

  // ⌘-clic / ⇧-clic select projects; the menu of a selected one acts on the selection.
  const selection = useProjectSelection((s) => s.ids);
  const selected = selection.includes(subject.id);
  const menu = (x: number, y: number) =>
    selected && selection.length > 1
      ? projectGroupItems(selection, subjects, { x, y })
      : subjectMenuItems(subject, { x, y }, subjects);
  const menuLabel =
    selected && selection.length > 1
      ? t.groups.selection(selection.length)
      : t.sidebar.projectMenu(subject.name);
  const onRowClick = (e: ReactMouseEvent) => {
    const sel = useProjectSelection.getState();
    if (e.metaKey || e.ctrlKey) {
      sel.toggle(subject.id);
      return;
    }
    if (e.shiftKey) {
      const order = subjects.filter((s) => !s.isGroup).map((s) => s.id);
      sel.range(subject.id, order);
      return;
    }
    sel.clear();
    setView({ kind: "subject", subjectId: subject.id });
  };

  if (renaming) {
    return (
      <div ref={setNodeRef}>
        <InlineNameInput
          color={subject.color}
          label={t.projectNav.renameLabel(subject.name)}
          initial={subject.name}
          onCommit={async (name) => {
            await saveSubjectName(subject, name);
            stopRename();
            return true;
          }}
          onCancel={stopRename}
        />
        {children}
      </div>
    );
  }

  // A group is a colored label, like Brave's tab groups. Clicking it folds
  // its projects; its menu renames it, changes its color or dissolves it.
  if (subject.isGroup) {
    const groupMenu = (x: number, y: number) =>
      groupMenuItems(subject, { x, y });
    const groupLabel = t.groups.menuLabel(subject.name);
    return (
      <div
        ref={setNodeRef}
        data-project-id={subject.id}
        data-group
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={isDragging ? "relative z-10 opacity-60" : undefined}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer drag surface; the inner button is the keyboard target */}
        <div
          {...pointerListeners}
          onContextMenu={(e) => {
            if (isTouchContextMenu(e)) e.preventDefault();
            else
              openContextMenu(e, groupMenu(e.clientX, e.clientY), groupLabel);
          }}
          className="group relative flex h-8 items-center"
        >
          <button
            ref={navRef}
            type="button"
            data-nav-item
            aria-expanded={!folded}
            aria-label={t.groups.toggle(subject.name, !folded)}
            onClick={() => useUi.getState().toggleSubProjects(subject.id)}
            onKeyDown={onNavKeyDown}
            className="ml-1 inline-flex h-7 max-w-[calc(100%-36px)] items-center rounded-md px-2.5 text-[13px] font-semibold"
            style={{
              background: `color-mix(in srgb, ${subjectColorVar(subject.color)} 22%, transparent)`,
              color: subjectColorVar(subject.color),
            }}
          >
            <span className="truncate">{subject.name}</span>
          </button>
          <IconButton
            label={groupLabel}
            size={24}
            className="absolute right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openMenuAt(
                e.currentTarget,
                groupMenu(rect.left, rect.bottom + 4),
                groupLabel,
              );
            }}
          >
            <Ellipsis size={15} aria-hidden />
          </IconButton>
        </div>
        {children}
      </div>
    );
  }

  // The drop and sort node wraps the row and its sub-projects: they move together.
  return (
    <div
      ref={setNodeRef}
      data-project-id={subject.id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer drag surface; the inner buttons are the keyboard targets */}
      <div
        {...pointerListeners}
        onContextMenu={(e) => {
          // Touch screen: the long press picks the project up; its menu stays on ⋯.
          if (isTouchContextMenu(e)) e.preventDefault();
          else openContextMenu(e, menu(e.clientX, e.clientY), menuLabel);
        }}
        className={`group ${navRowClass(isActive || selected)} ${
          taskOver ? "outline-2 outline-accent outline-dashed" : ""
        }`}
      >
        <button
          ref={navRef}
          type="button"
          data-nav-item
          aria-current={isActive ? "page" : undefined}
          aria-pressed={selected || undefined}
          data-selected={selected || undefined}
          onClick={onRowClick}
          onKeyDown={onNavKeyDown}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left"
        >
          <Pastille color={subject.color} />
          <span className="flex-1 truncate">{subject.name}</span>
          {/* A parent's dot includes its sub-projects' (the core aggregates it). */}
          {subject.dot && (
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: DOT_COLOR[subject.dot] }}
              title={t.ring.state(subject.dot, agent)}
            >
              <span className="sr-only">
                {t.ring.state(subject.dot, agent)}
              </span>
            </span>
          )}
          {/* A parent leaves room for its chevron, left of the count (always while folded,
              else on hover), so counts stay aligned. */}
          {isParent && (
            <span
              aria-hidden="true"
              className={`w-5 shrink-0 ${
                folded
                  ? ""
                  : "hidden group-focus-within:block group-hover:block"
              }`}
            />
          )}
          {(subject.openCount > 0 || isParent) && (
            <span
              className={`min-w-[14px] text-right text-[12px] font-normal group-hover:invisible group-focus-within:invisible ${
                isActive ? "" : "text-text-2"
              }`}
            >
              {subject.openCount > 0 ? subject.openCount : ""}
            </span>
          )}
        </button>
        {isParent && <SubProjectsToggle subject={subject} />}
        <IconButton
          label={menuLabel}
          size={24}
          className="absolute right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            openMenuAt(
              e.currentTarget,
              menu(rect.left, rect.bottom + 4),
              menuLabel,
            );
          }}
        >
          <Ellipsis size={15} aria-hidden />
        </IconButton>
      </div>
      {children}
    </div>
  );
}

/**
 * Sub-projects of a parent, indented one level: their own sortable list
 * (a drag stays within the level), and the in-place « Ajouter un sous-projet » input.
 */
function SubProjectList({
  parent,
  subProjects,
  subjects,
}: {
  parent: Subject;
  subProjects: Subject[];
  subjects: Subject[];
}) {
  const open = useUi((s) => s.collapsedProjects[parent.id] !== true);
  const adding = useUi(
    (s) => s.newProjectOpen && s.newProjectParentId === parent.id,
  );
  if (!open && !adding) return null;
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 pl-[18px]">
      {open && (
        <SortableContext
          items={subProjects.map((s) => dragId.subject(s.id))}
          strategy={verticalListSortingStrategy}
        >
          {subProjects.map((sub, i) => (
            <SubjectRow
              key={sub.id}
              subject={sub}
              index={i}
              count={subProjects.length}
              subjects={subjects}
            />
          ))}
        </SortableContext>
      )}
      {adding && <NewSubProjectInput parent={parent} subjects={subjects} />}
    </div>
  );
}

/** « Ajouter un sous-projet »: the new-project input, under its parent. */
function NewSubProjectInput({
  parent,
  subjects,
}: {
  parent: Subject;
  subjects: Subject[];
}) {
  const request = useUi((s) => s.newProjectRequest);
  const close = useUi((s) => s.closeNewProject);
  const color = nextProjectColor(subjects);
  return (
    <InlineNameInput
      color={color}
      label={t.subProjects.newLabel(parent.name)}
      placeholder={t.subProjects.newPlaceholder}
      hint={t.projectNav.newHint}
      focusKey={request}
      onCommit={async (name, fromBlur) => {
        // Enter opens the sub-project; leaving the field only saves it.
        const subject = await createProject(name, color, !fromBlur, parent.id);
        if (!subject) return false;
        close();
        return true;
      }}
      onCancel={close}
    />
  );
}

/**
 * « + Nouveau projet » (permanent line), or the dashed « + Crée ton premier projet » when there
 * is no project yet. Either turns into an input in place.
 */
function NewProjectLine({ subjects }: { subjects: Subject[] }) {
  // A new sub-project has its input under its parent.
  const open = useUi((s) => s.newProjectOpen && s.newProjectParentId === null);
  const request = useUi((s) => s.newProjectRequest);
  const start = useUi((s) => s.startNewProject);
  const close = useUi((s) => s.closeNewProject);
  const first = subjects.length === 0;

  if (open) {
    const color = nextProjectColor(subjects);
    return (
      <div className="mt-0.5" data-tutorial="new-project">
        <InlineNameInput
          color={color}
          label={t.projectNav.newLabel}
          placeholder={t.projectNav.newPlaceholder}
          hint={t.projectNav.newHint}
          focusKey={request}
          onCommit={async (name, fromBlur) => {
            // Enter opens the project; leaving the field only saves it.
            const subject = await createProject(name, color, !fromBlur);
            if (!subject) return false;
            close();
            return true;
          }}
          onCancel={close}
        />
      </div>
    );
  }

  if (first) {
    return (
      <button
        type="button"
        data-tutorial="new-project"
        onClick={() => start()}
        className="nav-row mt-0.5 flex h-[38px] w-full items-center gap-2.5 rounded-md border border-dashed border-border-input px-2 text-left text-body text-text-2"
      >
        <span className="flex w-[18px] shrink-0 justify-center">
          <Plus size={15} aria-hidden />
        </span>
        {t.sidebar.firstProject}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-tutorial="new-project"
      onClick={() => start()}
      title={withShortcut(t.sidebar.newProject, "⌘⇧N")}
      className="nav-row mt-0.5 flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-body text-text-2"
    >
      <span className="flex w-[18px] shrink-0 justify-center">
        <Plus size={15} aria-hidden />
      </span>
      <span className="flex-1 truncate">{t.sidebar.newProject}</span>
    </button>
  );
}

function ProjectsSkeleton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label={t.projectNav.loading}
      className="flex flex-col gap-0.5"
    >
      {visible &&
        [70, 55, 62].map((width) => (
          <div
            key={width}
            data-testid="project-skeleton"
            className="flex h-[34px] items-center gap-2.5 px-2"
          >
            <span className="flex w-[18px] justify-center">
              <span className="h-2.5 w-2.5 rounded-full bg-border motion-safe:animate-pulse" />
            </span>
            <span
              className="h-2.5 rounded-sm bg-border motion-safe:animate-pulse"
              style={{ width: `${width}%` }}
            />
          </div>
        ))}
    </div>
  );
}

function ProjectsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="text-[13px] text-text-2">
        {t.sidebar.projectsUnavailable}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {t.common.retry}
      </Button>
    </div>
  );
}

/** Réglages (gear, ⌘,): theme, editor, Claude Code and diagnostic. */
function SettingsButton() {
  return (
    <IconButton
      label={t.sidebar.settings}
      title={features.shortcuts ? t.settings.open : t.sidebar.settings}
      aria-haspopup="dialog"
      data-tutorial="settings"
      className="touch-target relative"
      onClick={() => useUi.getState().openDialog({ type: "settings" })}
    >
      <Settings size={16} aria-hidden />
    </IconButton>
  );
}

/** Folds the sidebar. */
function CollapseButton() {
  return (
    <IconButton
      label={t.sidebar.collapse}
      title={withShortcut(t.sidebar.collapse, "M")}
      className="touch-target relative"
      onClick={() => useUi.getState().toggleSidebar(false)}
    >
      <PanelLeftClose size={16} aria-hidden />
    </IconButton>
  );
}

/**
 * « Sans projet » among the top-level projects, at its stored place: the look of a navigation
 * row, dragged like a project (pointer only, never on the phone) or moved with ⌥↑ / ⌥↓, and a
 * drop target for tasks (they go back to « Sans projet »). No menu: never renamed nor deleted.
 */
function InboxRow({
  index,
  count,
  taskCount,
}: {
  /** Its index in the top-level order. */
  index: number;
  /** Number of top-level items, « Sans projet » included (⌥↓ bound). */
  count: number;
  /** Open tasks without a project. */
  taskCount: number;
}) {
  const data: DragData = {
    type: "subject",
    subjectId: null,
    name: t.sidebar.noProject,
    index,
    parentId: null,
  };
  const {
    setNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
    active: dragActive,
  } = useSortable({
    id: dragId.inbox(),
    data,
    disabled: !features.dragAndDrop,
  });
  // Pointer drag only, like a project row: ⌥↑ / ⌥↓ is the keyboard way.
  const { onKeyDown: _keyboardDrag, ...pointerListeners } = listeners ?? {};
  const navRef = useRef<HTMLButtonElement>(null);
  const focusMe = useProjectFocus((s) => s.focusId === INBOX_FOCUS_ID);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` changes when the moved row lands at its new place
  useEffect(() => {
    if (!focusMe) return;
    navRef.current?.focus();
    useProjectFocus.setState({ focusId: null });
  }, [focusMe, index]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    void moveInboxBy(index, count, e.key === "ArrowUp" ? -1 : 1);
  };
  const taskOver =
    isOver &&
    (dragActive?.data.current as DragData | undefined)?.type === "task";

  return (
    <div
      ref={setNodeRef}
      data-inbox-row
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      {/* Pointer drag surface; the inner button is the keyboard target. */}
      <div
        {...pointerListeners}
        className={
          taskOver ? "rounded-md outline-2 outline-accent outline-dashed" : ""
        }
      >
        <NavButton
          item={{ kind: "inbox", subjectId: null }}
          label={t.sidebar.noProject}
          icon={
            <Inbox size={16} aria-hidden strokeWidth={1.75} className="mx-px" />
          }
          count={taskCount}
          muted
          buttonRef={navRef}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

function ProjectList({
  showNoProject,
  noProjectCount,
}: {
  /** D2: « Sans projet » shows only while it holds a task (or its view is open). */
  showNoProject: boolean;
  noProjectCount: number;
}) {
  const query = useSubjects();
  const inboxQuery = useInboxIndex();
  if (query.isPending) return <ProjectsSkeleton />;
  if (query.isError) {
    return (
      <>
        <ProjectsError onRetry={() => void query.refetch()} />
        {showNoProject && (
          <InboxRow index={0} count={1} taskCount={noProjectCount} />
        )}
      </>
    );
  }
  const subjects = query.data;
  // `list_subjects` is flat (parents before their sub-projects); the sidebar nests one level.
  const ids = new Set(subjects.map((s) => s.id));
  const top = subjects.filter(
    (s) => s.parentId === null || !ids.has(s.parentId),
  );
  // Until the index is read, « Sans projet » stays last (its default place).
  const inboxIndex = Math.max(
    0,
    Math.min(inboxQuery.data ?? top.length, top.length),
  );
  // The top-level order with « Sans projet », counted even when hidden (the core's indices).
  const items = topLevelItems(top, inboxIndex);
  const count = items.length;
  const hiddenIndex = showNoProject ? null : inboxIndex;
  const shown = showNoProject
    ? items
    : items.filter((item) => item.kind !== "inbox");
  return (
    <>
      <SortableContext
        items={shown.map((item) =>
          item.kind === "inbox"
            ? dragId.inbox()
            : dragId.subject(item.subject.id),
        )}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-0.5">
          {items.map((item, index) => {
            if (item.kind === "inbox") {
              return showNoProject ? (
                <InboxRow
                  key={dragId.inbox()}
                  index={index}
                  count={count}
                  taskCount={noProjectCount}
                />
              ) : null;
            }
            const subject = item.subject;
            const subProjects = subProjectsOf(subject, subjects);
            return (
              <SubjectRow
                key={subject.id}
                subject={subject}
                index={index}
                count={count}
                hiddenIndex={hiddenIndex}
                subjects={subjects}
                subProjects={subProjects}
              >
                <SubProjectList
                  parent={subject}
                  subProjects={subProjects}
                  subjects={subjects}
                />
              </SubjectRow>
            );
          })}
        </div>
      </SortableContext>
      <NewProjectLine subjects={subjects} />
    </>
  );
}

export function Sidebar() {
  const counts = useCounts().data;
  // The portfolio's wide table needs a large screen (the Mac, or 1024 px on the web).
  const largeScreen = useLargeScreen();
  const noProjectCount = counts?.inbox ?? 0;
  // D2: the line shows while « Sans projet » holds a task, open or completed, and never
  // vanishes under the user while its view is on screen.
  const hasNoProjectTasks = useHasNoProjectTasks();
  const onNoProject = useUi((s) => s.view.kind === "inbox");
  const showNoProject = hasNoProjectTasks === true || onNoProject;

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-[14px] font-semibold">{t.appName}</span>
        <div className="flex items-center gap-0.5">
          <SyncButton />
          <SettingsButton />
          <CollapseButton />
        </div>
      </div>

      <div className="px-2.5">
        <button
          type="button"
          onClick={() => openAddTaskForView()}
          title={withShortcut(t.sidebar.newTask, "⌘N")}
          className="nav-row flex h-[34px] w-full items-center gap-2.5 rounded-md px-2 text-[14px] text-text-2"
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-current">
            <Plus size={12} strokeWidth={2.25} aria-hidden />
          </span>
          <span className="flex-1 text-left">{t.sidebar.newTask}</span>
          {features.shortcuts && (
            <kbd className="font-sans text-[12px] text-text-3">⌘N</kbd>
          )}
        </button>
        {/* « Recherche » as a row, like Todoist; it opens ⌘K. */}
        {features.search && (
          <button
            type="button"
            data-nav-item
            aria-haspopup="dialog"
            aria-label={t.sidebar.searchRow}
            onClick={() => useUi.getState().openDialog({ type: "search" })}
            title={
              features.shortcuts ? `${t.search.open} (⌘K)` : t.sidebar.searchRow
            }
            className="nav-row flex h-[34px] w-full items-center gap-2.5 rounded-md px-2 text-body text-text"
          >
            <Search size={18} aria-hidden strokeWidth={1.75} />
            <span className="flex-1 text-left">{t.sidebar.searchRow}</span>
            {features.shortcuts && (
              <kbd className="font-sans text-[12px] text-text-3">⌘K</kbd>
            )}
          </button>
        )}
      </div>

      <nav
        aria-label={t.sidebar.navLabel}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-2.5 pt-1">
          {/* Every open task, grouped by project; first and opened at launch. */}
          <NavButton
            item={{ kind: "all", subjectId: null }}
            label={t.all.title}
            title={withShortcut(t.all.title, "⌘1")}
            icon={<ListTodo size={18} aria-hidden strokeWidth={1.75} />}
            count={0}
            shortcut="⌘1"
          />
          <NavButton
            item={{ kind: "today", subjectId: null }}
            label={t.sidebar.today}
            title={withShortcut(t.sidebar.today, "⌘2")}
            icon={<CalendarDays size={18} aria-hidden strokeWidth={1.75} />}
            count={counts?.today ?? 0}
            waiting={features.states ? (counts?.waiting ?? 0) : 0}
          />
          <NavButton
            item={{ kind: "upcoming", subjectId: null }}
            label={t.sidebar.upcoming}
            title={withShortcut(t.sidebar.upcoming, "⌘3")}
            icon={<CalendarRange size={18} aria-hidden strokeWidth={1.75} />}
            count={0}
            shortcut="⌘3"
          />
          {/* every project on one line (not on a phone: no wide table). */}
          {largeScreen && (
            <NavButton
              item={{ kind: "portfolio", subjectId: null }}
              label={t.portfolio.title}
              icon={
                <BriefcaseBusiness size={18} aria-hidden strokeWidth={1.75} />
              }
              count={0}
            />
          )}
        </div>

        <div className="mx-4 mt-3 border-t border-border" />
        <h2 className="mt-3 pr-2.5 pb-1 pl-4 text-[13px] leading-6 font-semibold">
          {t.sidebar.projects}
        </h2>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          <ProjectList
            showNoProject={showNoProject}
            noProjectCount={noProjectCount}
          />
        </div>
      </nav>
    </aside>
  );
}
