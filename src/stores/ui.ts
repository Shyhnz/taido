/**
 * UI-only state (never data): active view, open and selected task, list focus, dialogs,
 * inline project creation. Data lives in TanStack Query (src/lib/queries.ts).
 *
 * Every launch opens « À faire » (replaces the last-view memory). Folds and the sidebar are remembered in `localStorage`; storage may be
 * unavailable, so every access is guarded.
 */

import { create } from "zustand";
import type { AddTarget, Agent, Due, ViewKind } from "../bindings";

export interface ActiveView {
  kind: ViewKind;
  /** Set when `kind` is "subject". */
  subjectId: string | null;
}

/** Visible task of the current list, in display order (keyboard navigation). */
export interface VisibleTask {
  id: string;
  completed: boolean;
}

/** Tabs of « Réglages ». `sync`: see docs/SYNC.md § 5. */
export type SettingsTab =
  | "general"
  | "theme"
  | "sync"
  | "agents"
  | "diagnostic";

/** Tabs of a project's header; « Notes »: the project notebook. */
export type ProjectTab = "list" | "board" | "dashboard" | "notes";

/** Why an agent cannot be launched (check before its first launch). */
export type ClaudeProblem = "missing" | "notLoggedIn";

export type DialogState =
  | { type: "addTask"; target: AddTarget }
  /** `file`: opened from « Ranger dans… » (a task of « Sans projet »). */
  | { type: "moveTask"; taskId: string; file?: boolean }
  | { type: "due"; taskId: string; due: Due | null }
  /** ⌘K « Aller à une tâche ». */
  | { type: "search" }
  /** « Réglages » (gear of the sidebar, ⌘,), opened on `tab`. */
  | { type: "settings"; tab?: SettingsTab }
  /** Claude Code is missing or logged out, before a Claude launch. */
  | { type: "claudeCheck"; problem: ClaudeProblem; agent: Agent };

interface UiState {
  view: ActiveView;
  openTaskId: string | null;
  selectedTaskId: string | null;
  /** True when the keyboard focus is in the task list (j/k, Enter…). */
  listFocused: boolean;
  /** Tasks shown by the current view, for ↑/↓, Enter and ⌘Enter. */
  visibleTasks: VisibleTask[];
  dialog: DialogState | null;
  /**
   * The sidebar « + Nouveau projet » line is an input. Opened by the line itself,
   * the first-launch button and ⌘⇧N (`startNewProject`).
   */
  newProjectOpen: boolean;
  /** Bumped by every `startNewProject` call so an already open input takes the focus back. */
  newProjectRequest: number;
  /**
   * Parent of the project being created (« Ajouter un sous-projet »); the
   * input then shows under that parent's sub-projects. `null` for a top-level project.
   */
  newProjectParentId: string | null;
  /**
   * Focus mode: the task panel takes the whole window. Leaving it restores the
   * previous layout; closing the panel or changing view leaves it too.
   */
  focusMode: boolean;
  /** Tab shown in each task's « Session » block (task id → terminal id). */
  activeTerminals: Record<string, string>;
  /**
   * Tasks whose subtasks are folded in the lists (chevron), remembered in
   * `localStorage`. Unfolded by default, like Todoist.
   */
  collapsedTasks: Record<string, true>;
  /**
   * Parent projects whose sub-projects are folded in the sidebar (chevron),
   * remembered in `localStorage`. Unfolded by default, like Todoist.
   */
  collapsedProjects: Record<string, true>;
  /**
   * First day (a Monday, `YYYY-MM-DD`) of the week « Prochainement »
   * shows; `null` = the current week.
   */
  upcomingWeek: string | null;
  /**
   * « Prochainement » shown as a list of days or as a month calendar (2026-10-12),
   * remembered in `localStorage`.
   */
  upcomingMode: UpcomingMode;
  /** First day (`YYYY-MM-01`) of the month the calendar shows; `null` = this month. */
  upcomingMonth: string | null;
  /** Period of the dashboards, 7 or 30 days. */
  dashboardDays: 7 | 30;
  /**
   * Sidebar shown: open by default, folded with its button or « M »,
   * remembered in `localStorage`. On the phone it is the drawer over the list.
   */
  sidebarOpen: boolean;
  /** « Liste » or « Kanban », the same for every project (kept across them). */
  projectTab: ProjectTab;
  /** « Demander au projet »: the project whose panel is open (Mac only). */
  askSubjectId: string | null;
  /** Opens the panel (the task panel closes; it hides the panel while a task is open). */
  openAsk: (subjectId: string) => void;
  closeAsk: () => void;

  setView: (view: ActiveView) => void;
  openTask: (id: string | null) => void;
  selectTask: (id: string | null) => void;
  setListFocused: (focused: boolean) => void;
  setVisibleTasks: (tasks: VisibleTask[]) => void;
  moveSelection: (delta: 1 | -1) => void;
  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;
  /**
   * Opens the inline « Nouveau projet » input (sidebar line, first launch, ⌘⇧N), or, with
   * `parentId`, the one of a new sub-project under that parent (unfolded).
   */
  startNewProject: (parentId?: string) => void;
  closeNewProject: () => void;
  setFocusMode: (on: boolean) => void;
  setActiveTerminal: (taskId: string, terminalId: string) => void;
  /** Folds or unfolds the subtasks of a task in the lists; `open` forces a state. */
  toggleChildren: (taskId: string, open?: boolean) => void;
  /** Folds or unfolds the sub-projects of a parent in the sidebar; `open` forces a state. */
  toggleSubProjects: (subjectId: string, open?: boolean) => void;
  setUpcomingWeek: (monday: string | null) => void;
  setUpcomingMode: (mode: UpcomingMode) => void;
  setUpcomingMonth: (month: string | null) => void;
  /** Shows or folds the sidebar; `open` forces a state. */
  toggleSidebar: (open?: boolean) => void;
  /**
   * Notebook: last page opened in each project (subject id → page id), remembered in
   * `localStorage`; the « Notes » tab opens on it.
   */
  lastNotePage: Record<string, string>;
  /** Phone: the page shown as a full-screen sheet over the list; `null` = the list. */
  notePageSheet: string | null;
  /** Folded group headers of the notebooks (`noteFoldKey`), remembered in `localStorage`. */
  foldedNoteGroups: Record<string, true>;
  setProjectTab: (tab: ProjectTab) => void;
  /** Shows `pageId` in the notebook of `subjectId` (and remembers it); `sheet`: phone sheet. */
  openNotePage: (subjectId: string, pageId: string, sheet?: boolean) => void;
  closeNotePageSheet: () => void;
  /** Folds or unfolds a notebook group header; `open` forces a state. */
  toggleNoteGroup: (key: string, open?: boolean) => void;
  setDashboardDays: (days: 7 | 30) => void;
}

/** `localStorage` key of the last page opened in each notebook. */
export const LAST_NOTE_PAGE_KEY = "todo.lastNotePage";

/** `localStorage` key of the folded notebook group headers. */
export const FOLDED_NOTE_GROUPS_KEY = "todo.foldedNoteGroups";

/**
 * Key of a notebook group header in `foldedNoteGroups`: a group's id, or « Épinglées » /
 * « Résumés de tâches » of a project.
 */
export function noteFoldKey(
  subjectId: string,
  block: "pinned" | "summaries" | { group: string },
): string {
  return typeof block === "object" ? block.group : `${block}:${subjectId}`;
}

function loadLastNotePages(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(LAST_NOTE_PAGE_KEY) ?? "{}",
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveLastNotePages(pages: Record<string, string>): void {
  try {
    window.localStorage.setItem(LAST_NOTE_PAGE_KEY, JSON.stringify(pages));
  } catch {
    // Storage unavailable: the notebook opens on its first page next time.
  }
}

/** View of every launch: « À faire ». */
export const INITIAL_VIEW: ActiveView = { kind: "all", subjectId: null };

/** Key of the last-view memory removed (an old value is simply ignored). */
const OLD_LAST_VIEW_KEY = "todo.lastView";

/** `localStorage` key of the tasks whose subtasks are folded. */
export const COLLAPSED_KEY = "todo.collapsedTasks";

/** `localStorage` key of the parent projects whose sub-projects are folded. */
export const COLLAPSED_PROJECTS_KEY = "todo.collapsedProjects";

/** Folded ids, or none when nothing is stored or storage is unavailable. */
export function loadCollapsed(key = COLLAPSED_KEY): Record<string, true> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return {};
    const out: Record<string, true> = {};
    for (const id of value) if (typeof id === "string") out[id] = true;
    return out;
  } catch {
    return {};
  }
}

function saveCollapsed(
  collapsed: Record<string, true>,
  key = COLLAPSED_KEY,
): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.keys(collapsed)));
  } catch {
    // Storage unavailable: the folds are forgotten at the next launch.
  }
}

/** New fold map after folding (`fold`) or unfolding `id`; the same object when unchanged. */
function setFold(
  collapsed: Record<string, true>,
  id: string,
  open: boolean | undefined,
): Record<string, true> {
  const folded = collapsed[id] === true;
  const fold = open === undefined ? !folded : !open;
  if (fold === folded) return collapsed;
  const next = { ...collapsed };
  if (fold) next[id] = true;
  else delete next[id];
  return next;
}

/** `localStorage` key of the sidebar's folded state. */
export const SIDEBAR_KEY = "todo.sidebarOpen";

/** Open unless the user folded it; open when storage is unavailable. */
export function loadSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveSidebarOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(open));
  } catch {
    // Storage unavailable: the sidebar opens again at the next launch.
  }
}

/** « Prochainement » as a list of days or as a month calendar. */
export type UpcomingMode = "list" | "calendar";

/** `localStorage` key of the « Prochainement » display (2026-10-12). */
export const UPCOMING_MODE_KEY = "todo.upcomingMode";

/** The list unless the calendar was chosen; the list when storage is unavailable. */
function loadUpcomingMode(): UpcomingMode {
  try {
    return window.localStorage.getItem(UPCOMING_MODE_KEY) === "calendar"
      ? "calendar"
      : "list";
  } catch {
    return "list";
  }
}

function saveUpcomingMode(mode: UpcomingMode): void {
  try {
    window.localStorage.setItem(UPCOMING_MODE_KEY, mode);
  } catch {
    // Storage unavailable: the list comes back at the next launch.
  }
}

function clearLastView(): void {
  try {
    window.localStorage.removeItem(OLD_LAST_VIEW_KEY);
    window.localStorage.removeItem(COLLAPSED_KEY);
    window.localStorage.removeItem(COLLAPSED_PROJECTS_KEY);
    window.localStorage.removeItem(SIDEBAR_KEY);
    window.localStorage.removeItem(UPCOMING_MODE_KEY);
    window.localStorage.removeItem(LAST_NOTE_PAGE_KEY);
    window.localStorage.removeItem(FOLDED_NOTE_GROUPS_KEY);
  } catch {
    // Nothing to clear.
  }
}

export const useUi = create<UiState>((set, get) => ({
  view: INITIAL_VIEW,
  openTaskId: null,
  selectedTaskId: null,
  listFocused: false,
  visibleTasks: [],
  dialog: null,
  newProjectOpen: false,
  newProjectRequest: 0,
  newProjectParentId: null,
  focusMode: false,
  activeTerminals: {},
  collapsedTasks: loadCollapsed(),
  collapsedProjects: loadCollapsed(COLLAPSED_PROJECTS_KEY),
  upcomingWeek: null,
  upcomingMode: loadUpcomingMode(),
  upcomingMonth: null,
  sidebarOpen: loadSidebarOpen(),
  projectTab: "list",
  askSubjectId: null,
  openAsk: (subjectId) =>
    set({ askSubjectId: subjectId, openTaskId: null, focusMode: false }),
  closeAsk: () => set({ askSubjectId: null }),
  dashboardDays: 7,
  lastNotePage: loadLastNotePages(),
  notePageSheet: null,
  foldedNoteGroups: loadCollapsed(FOLDED_NOTE_GROUPS_KEY),

  setView: (view) => {
    set({ view, selectedTaskId: null, focusMode: false, notePageSheet: null });
  },
  openTask: (id) =>
    set(
      id
        ? { openTaskId: id, selectedTaskId: id }
        : { openTaskId: null, focusMode: false },
    ),
  selectTask: (id) => set({ selectedTaskId: id }),
  setListFocused: (listFocused) => set({ listFocused }),
  setVisibleTasks: (visibleTasks) => {
    const same =
      visibleTasks.length === get().visibleTasks.length &&
      visibleTasks.every(
        (t, i) =>
          t.id === get().visibleTasks[i]?.id &&
          t.completed === get().visibleTasks[i]?.completed,
      );
    if (!same) set({ visibleTasks });
  },
  moveSelection: (delta) => {
    const { visibleTasks, selectedTaskId } = get();
    if (visibleTasks.length === 0) return;
    const index = visibleTasks.findIndex((t) => t.id === selectedTaskId);
    const next =
      index === -1
        ? delta === 1
          ? 0
          : visibleTasks.length - 1
        : Math.max(0, Math.min(visibleTasks.length - 1, index + delta));
    set({ selectedTaskId: visibleTasks[next].id, listFocused: true });
  },
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  startNewProject: (parentId) =>
    set((s) => {
      const newProjectParentId = parentId ?? null;
      const collapsedProjects =
        newProjectParentId === null
          ? s.collapsedProjects
          : setFold(s.collapsedProjects, newProjectParentId, true);
      if (collapsedProjects !== s.collapsedProjects) {
        saveCollapsed(collapsedProjects, COLLAPSED_PROJECTS_KEY);
      }
      return {
        newProjectOpen: true,
        newProjectRequest: s.newProjectRequest + 1,
        newProjectParentId,
        collapsedProjects,
      };
    }),
  closeNewProject: () => set({ newProjectOpen: false }),
  setFocusMode: (on) => set({ focusMode: on && get().openTaskId !== null }),
  setActiveTerminal: (taskId, terminalId) =>
    set((s) =>
      s.activeTerminals[taskId] === terminalId
        ? s
        : { activeTerminals: { ...s.activeTerminals, [taskId]: terminalId } },
    ),
  toggleChildren: (taskId, open) =>
    set((s) => {
      const collapsedTasks = setFold(s.collapsedTasks, taskId, open);
      if (collapsedTasks === s.collapsedTasks) return s;
      saveCollapsed(collapsedTasks);
      return { collapsedTasks };
    }),
  toggleSubProjects: (subjectId, open) =>
    set((s) => {
      const collapsedProjects = setFold(s.collapsedProjects, subjectId, open);
      if (collapsedProjects === s.collapsedProjects) return s;
      saveCollapsed(collapsedProjects, COLLAPSED_PROJECTS_KEY);
      return { collapsedProjects };
    }),
  setUpcomingWeek: (upcomingWeek) => set({ upcomingWeek }),
  setUpcomingMode: (upcomingMode) => {
    saveUpcomingMode(upcomingMode);
    set({ upcomingMode });
  },
  setUpcomingMonth: (upcomingMonth) => set({ upcomingMonth }),
  toggleSidebar: (open) =>
    set((s) => {
      const sidebarOpen = open ?? !s.sidebarOpen;
      if (sidebarOpen === s.sidebarOpen) return s;
      saveSidebarOpen(sidebarOpen);
      return { sidebarOpen };
    }),
  setProjectTab: (projectTab) => set({ projectTab, notePageSheet: null }),
  openNotePage: (subjectId, pageId, sheet = false) =>
    set((s) => {
      const lastNotePage =
        s.lastNotePage[subjectId] === pageId
          ? s.lastNotePage
          : { ...s.lastNotePage, [subjectId]: pageId };
      if (lastNotePage !== s.lastNotePage) saveLastNotePages(lastNotePage);
      return {
        lastNotePage,
        notePageSheet: sheet ? pageId : s.notePageSheet,
      };
    }),
  closeNotePageSheet: () => set({ notePageSheet: null }),
  toggleNoteGroup: (key, open) =>
    set((s) => {
      const foldedNoteGroups = setFold(s.foldedNoteGroups, key, open);
      if (foldedNoteGroups === s.foldedNoteGroups) return s;
      saveCollapsed(foldedNoteGroups, FOLDED_NOTE_GROUPS_KEY);
      return { foldedNoteGroups };
    }),
  setDashboardDays: (dashboardDays) => set({ dashboardDays }),
}));

/** Resets the store and forgets the last view (tests). */
export function resetUi(): void {
  clearLastView();
  useUi.setState({
    // Tests start on Aujourd'hui, the view most of them exercise; launch.test checks
    // that the app itself opens on « À faire ».
    view: { kind: "today", subjectId: null },
    openTaskId: null,
    selectedTaskId: null,
    listFocused: false,
    visibleTasks: [],
    dialog: null,
    newProjectOpen: false,
    newProjectRequest: 0,
    newProjectParentId: null,
    focusMode: false,
    activeTerminals: {},
    collapsedTasks: {},
    collapsedProjects: {},
    upcomingWeek: null,
    upcomingMode: "list",
    upcomingMonth: null,
    sidebarOpen: true,
    projectTab: "list",
    askSubjectId: null,
    dashboardDays: 7,
    lastNotePage: {},
    notePageSheet: null,
    foldedNoteGroups: {},
  });
}
